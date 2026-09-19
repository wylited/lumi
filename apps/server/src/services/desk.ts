import { randomUUID } from 'node:crypto'

import {
  ApiToDesk,
  CommandState,
  DeskAction,
  DeskActionResult,
  DeskCamera,
  DeskArm,
  DeskHealth,
} from '@heli/contracts'
import type {
  Desk as DeskContract,
  DeskActionRecord,
  DeskAck,
  DeskActionRequest,
  DeskHello,
  DeskRegistration,
} from '@heli/contracts'
import type { Desk as DeskRow, DeskAction as DeskActionRow } from '@prisma/client'

import { signDeskToken, verifyDeskToken } from '../lib/jwt.js'
import { childLogger } from '../logger.js'
import { prisma } from '../lib/prisma.js'

const log = childLogger({ module: 'desk' })

/**
 * The desk: one rig, registered once, addressed by actions.
 *
 * Three pieces of state, deliberately kept apart:
 *   - the **row**, which is what survives a restart: the name, the caps, when it
 *     was last seen, and every action ever issued;
 *   - the **socket**, which is process-local by nature and is the only way an
 *     action can actually reach the rig;
 *   - the **health**, which is a heartbeat — losing it is not an error, it just
 *     means nothing has reported in yet.
 */

/** What the socket needs to be, so this file never imports fastify or `ws`. */
export interface DeskSocketLike {
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
  readonly readyState?: number
}

/**
 * How long an action may sit unacked before it is a failure.
 *
 * The phase doc names 10 s, and it matches the retired device socket's rule, so
 * the rig author has one number to remember.
 */
export const ACK_TIMEOUT_MS = 10_000

/** Auth for `/ws/desk`. Re-exported so the socket imports one module, not two. */
export { verifyDeskToken }

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode })

/* ---- rows to contracts --------------------------------------------------- */

/**
 * A `Desk` row as the contract's `Desk`.
 *
 * `camera` and `arm` are `Json` columns, so they can hold anything a previous
 * version wrote. Each is parsed through its contract rather than passed through:
 * a desk whose caps cannot be read registers with `null` caps, which the contract
 * allows and which the panel renders as "unknown", instead of turning every read
 * of the desk panel into a 500.
 */
export function toApiDesk(row: DeskRow): DeskContract {
  const camera = DeskCamera.safeParse(row.camera)
  const arm = DeskArm.safeParse(row.arm)

  if (!camera.success && row.camera !== null) {
    log.warn({ deskId: row.id, issues: camera.error.issues }, 'desk camera caps are not readable')
  }
  if (!arm.success && row.arm !== null) {
    log.warn({ deskId: row.id, issues: arm.error.issues }, 'desk arm caps are not readable')
  }

  return {
    id: row.id,
    name: row.name,
    camera: camera.success ? camera.data : null,
    arm: arm.success ? arm.data : null,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
  }
}

const toApiAction = (row: DeskActionRow): DeskActionRecord => {
  const status = CommandState.safeParse(row.status)
  const result = row.result === null ? null : DeskActionResult.safeParse(row.result)

  return {
    id: row.id,
    type: row.type,
    // An unrecognised status is a bug in this file rather than a client problem,
    // but 'failed' is the honest way to describe "we do not know what happened".
    status: status.success ? status.data : 'failed',
    issuedAt: row.issuedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    result: result !== null && result.success ? result.data : null,
    error: row.error,
  }
}

/* ---- registration -------------------------------------------------------- */

/**
 * Registers or updates the one desk.
 *
 * Idempotent on the id the rig stores locally, because setup is re-runnable:
 * changing the camera or the name must update the desk, not create a second one.
 * The token is reissued every time, so re-running setup also rotates a token the
 * rig may have lost.
 */
export async function registerDesk(
  input: DeskRegistration,
): Promise<{ desk: DeskContract; deskToken: string }> {
  const row = await prisma.desk.upsert({
    where: { id: input.deskId },
    create: {
      id: input.deskId,
      name: input.name,
      camera: input.camera ?? undefined,
      arm: input.arm ?? undefined,
      lastSeenAt: new Date(),
    },
    update: {
      name: input.name,
      camera: input.camera ?? undefined,
      arm: input.arm ?? undefined,
      lastSeenAt: new Date(),
    },
  })

  log.info({ deskId: row.id, hasArm: row.arm !== null }, 'desk registered')
  return { desk: toApiDesk(row), deskToken: signDeskToken(row.id) }
}

/** The one desk, or null before setup has ever run. */
export async function getTheDesk(): Promise<DeskContract | null> {
  const row = await prisma.desk.findFirst({ orderBy: { registeredAt: 'asc' } })
  return row === null ? null : toApiDesk(row)
}

export async function getDesk(id: string): Promise<DeskContract | null> {
  const row = await prisma.desk.findUnique({ where: { id } })
  return row === null ? null : toApiDesk(row)
}

/** The row's id, for the socket and the action log, without mapping it. */
export async function deskRowExists(id: string): Promise<boolean> {
  const row = await prisma.desk.findUnique({ where: { id }, select: { id: true } })
  return row !== null
}

/* ---- the live socket ---------------------------------------------------- */

interface LiveDesk {
  socket: DeskSocketLike
  health: DeskHealth | null
}

const live = new Map<string, LiveDesk>()

/**
 * Binds a socket to a desk, replacing any previous one.
 *
 * A rig that reconnects must not leave the old socket addressable: an action sent
 * to a dead socket looks delivered and then times out, which is exactly the
 * failure the ack loop exists to make visible.
 */
export function attachDeskSocket(deskId: string, socket: DeskSocketLike): void {
  const previous = live.get(deskId)
  if (previous !== undefined && previous.socket !== socket) {
    log.info({ deskId }, 'a second desk socket replaced the first')
  }
  live.set(deskId, { socket, health: previous?.health ?? null })
}

/**
 * Releases a socket, but only if it is still the live one.
 *
 * A replaced socket's teardown runs *after* the newer one attached, so an
 * unconditional delete would report a connected rig as disconnected.
 *
 * It also **fails every action still waiting on that socket**, immediately and
 * as `desk_offline`. Without this, an action dispatched to a rig that then drops
 * sits out the full 10 s ack timeout — twice, for a retryable type — and is
 * recorded as `ack_timeout`, which blames the rig's responsiveness for a cable
 * that came out. The socket knows the moment the connection dies; this is where
 * that news has to land.
 */
export function detachDeskSocket(deskId: string, socket: DeskSocketLike): void {
  const current = live.get(deskId)
  if (current === undefined || current.socket !== socket) return
  live.delete(deskId)
  void failPendingFor(deskId, 'desk_offline')
}

/** Settles every action this desk is still waiting on. */
async function failPendingFor(deskId: string, reason: string): Promise<void> {
  const waiting = [...pending.entries()].filter(([, entry]) => entry.deskId === deskId)
  for (const [actionId] of waiting) {
    await settle(actionId, 'failed', null, reason)
  }
}

export const isDeskConnected = (deskId: string): boolean => live.has(deskId)

export const deskHealthOf = (deskId: string): DeskHealth | null => live.get(deskId)?.health ?? null

/** The socket, so the action loop can write to it. Module-private by intent. */
const socketOf = (deskId: string): DeskSocketLike | null => live.get(deskId)?.socket ?? null

/** `hello` is the rig saying what it is; it is worth persisting. */
export async function recordDeskHello(deskId: string, hello: DeskHello): Promise<void> {
  await prisma.desk.updateMany({
    where: { id: deskId },
    data: {
      camera: hello.camera ?? undefined,
      arm: hello.arm ?? undefined,
      lastSeenAt: new Date(),
    },
  })
  log.info(
    { deskId, agentVersion: hello.agentVersion, hasArm: hello.arm !== null },
    'desk said hello',
  )
}

/**
 * Health is a heartbeat, so it is held in memory rather than written on every
 * report: at one every 5 s a row update would be 720 writes an hour to keep a
 * number the panel reads live anyway.
 */
export function recordDeskHealth(deskId: string, health: DeskHealth): void {
  const current = live.get(deskId)
  if (current === undefined) return
  current.health = health
  void prisma.desk
    .updateMany({ where: { id: deskId }, data: { lastSeenAt: new Date() } })
    .catch((error: unknown) => {
      log.warn({ deskId, err: error }, 'could not stamp lastSeenAt')
    })
}

/* ---- actions ------------------------------------------------------------ */

interface Pending {
  deskId: string
  resolve: (outcome: { status: 'done' | 'failed'; result: DeskActionResult | null; error: string | null }) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

/**
 * Actions that may be sent twice.
 *
 * A retry is only safe when performing the action twice has the same effect as
 * performing it once. `capture` is deliberately absent: retrying it takes a
 * second frame for one request, and the frame the assessment reads is then not
 * the frame the person asked for. `arm.nod` is absent for the same reason in
 * physical form — two nods is a different gesture.
 */
const RETRYABLE: ReadonlySet<string> = new Set([
  'stream.start',
  'stream.stop',
  'camera.zoom',
  'arm.aim',
  'arm.point',
  'arm.home',
])

/**
 * Turns a loose `{ type, payload }` request into a validated action.
 *
 * The parse runs against the contract's own discriminated union rather than a
 * table of payload shapes written here, so the route cannot accept a payload the
 * contract forbids and cannot drift from it either.
 */
export function buildAction(request: DeskActionRequest): DeskAction {
  const candidate = {
    t: 'action' as const,
    id: randomUUID(),
    issuedAt: new Date().toISOString(),
    type: request.type,
    payload: request.payload,
  }
  const parsed = DeskAction.safeParse(candidate)
  if (!parsed.success) {
    throw httpError(400, `Not a ${request.type} action this rig can be sent.`)
  }
  return parsed.data
}

/** Writes the terminal state of an action and answers whoever is waiting. */
async function settle(
  actionId: string,
  status: 'done' | 'failed',
  result: DeskActionResult | null,
  error: string | null,
): Promise<void> {
  const waiting = pending.get(actionId)
  if (waiting !== undefined) {
    pending.delete(actionId)
    clearTimeout(waiting.timer)
  }

  await prisma.deskAction.updateMany({
    where: { id: actionId },
    data: { status, result: result ?? undefined, error, completedAt: new Date() },
  })

  waiting?.resolve({ status, result, error })
}

/** The ack that arrived over the socket, matched to the action waiting on it. */
export function resolveActionAck(deskId: string, ack: DeskAck): void {
  const waiting = pending.get(ack.actionId)
  if (waiting === undefined) {
    // Late, duplicated, or for an action this process never issued — after a
    // restart, for instance. Worth a line, never worth an error the rig sees.
    log.warn({ deskId, actionId: ack.actionId, status: ack.status }, 'an ack nobody was waiting for')
    return
  }
  if (ack.status === 'accepted') {
    // The rig has taken it. The record stays `dispatched`; the timeout still runs,
    // because "accepted" is not "done".
    log.debug({ deskId, actionId: ack.actionId }, 'desk accepted the action')
    return
  }

  void settle(
    ack.actionId,
    ack.status === 'done' ? 'done' : 'failed',
    ack.result,
    ack.error ?? (ack.status === 'failed' ? 'the rig reported a failure' : null),
  )
}

/** One attempt: write to the socket and wait for the ack, or give up. */
function attempt(deskId: string, action: DeskAction, timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const socket = socketOf(deskId)
    if (socket === null) return resolve('desk_offline')

    const timer = setTimeout(() => {
      pending.delete(action.id)
      resolve('ack_timeout')
    }, timeoutMs)

    pending.set(action.id, {
      deskId,
      timer,
      resolve: () => {
        clearTimeout(timer)
        resolve(null)
      },
    })

    try {
      // A last check before the wire, the same way the socket guards the frames
      // it writes. `buildAction` already parsed this against the contract, so a
      // failure here means something built an action without going through it —
      // and a rig cannot report a frame it could not read, because this socket is
      // its only channel home.
      const validated = ApiToDesk.safeParse(action)
      if (!validated.success) {
        clearTimeout(timer)
        pending.delete(action.id)
        log.error(
          { deskId, actionId: action.id, issues: validated.error.issues },
          'refused to send an action that is not an ApiToDesk frame',
        )
        return resolve('invalid_action')
      }

      socket.send(JSON.stringify(validated.data))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(action.id)
      log.warn({ deskId, actionId: action.id, err: error }, 'could not write to the desk socket')
      resolve('desk_offline')
    }
  })
}

/**
 * Issues an action and waits for it to be done.
 *
 * The lifecycle the phase doc asks for, in order: persist it as queued, refuse
 * immediately when there is no rig rather than making the caller wait out a
 * timeout, dispatch, wait 10 s for the ack, retry **once** when the action is
 * safe to repeat, and otherwise fail with `ack_timeout`. Every terminal state is
 * on the row, so the log tells the truth about what happened after the fact.
 */
export async function issueAction(
  deskId: string,
  action: DeskAction,
): Promise<DeskActionRecord> {
  await prisma.deskAction.create({
    data: {
      id: action.id,
      deskId,
      type: action.type,
      payload: action.payload as object,
      status: 'queued',
      issuedAt: new Date(action.issuedAt),
    },
  })

  if (socketOf(deskId) === null) {
    // No socket at all: do not spend 10 s discovering it. The action has to exist
    // in the log as a failure, because "I pressed it and nothing happened" is the
    // one outcome the panel must never produce.
    await settle(action.id, 'failed', null, 'desk_offline')
    return readAction(action.id)
  }

  await prisma.deskAction.updateMany({ where: { id: action.id }, data: { status: 'dispatched' } })

  let failure = await attempt(deskId, action, ACK_TIMEOUT_MS)

  if (failure !== null && RETRYABLE.has(action.type)) {
    log.info({ deskId, actionId: action.id, type: action.type }, 'retrying an idempotent action once')
    failure = await attempt(deskId, action, ACK_TIMEOUT_MS)
  }

  if (failure !== null) await settle(action.id, 'failed', null, failure)

  return readAction(action.id)
}

const readAction = async (actionId: string): Promise<DeskActionRecord> => {
  const row = await prisma.deskAction.findUnique({ where: { id: actionId } })
  if (row === null) throw new Error(`desk action ${actionId} vanished`)
  return toApiAction(row)
}

/** The action log, newest first — what the panel shows and a reviewer reads. */
export async function listActions(deskId: string, limit = 50): Promise<DeskActionRecord[]> {
  const rows = await prisma.deskAction.findMany({
    where: { deskId },
    orderBy: { issuedAt: 'desc' },
    take: limit,
  })
  return rows.map(toApiAction)
}

/** For tests and probes: forget the live sockets and pending waits. */
export function resetDeskRuntime(): void {
  for (const waiting of pending.values()) clearTimeout(waiting.timer)
  pending.clear()
  live.clear()
}
