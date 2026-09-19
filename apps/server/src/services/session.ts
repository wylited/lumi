import type {
  Goal as ApiGoal,
  Intervention as ApiIntervention,
  Observation as ApiObservation,
  OpenSessionResponse,
  Session as ApiSession,
  SessionDetail,
  SessionSummary,
} from '@heli/contracts'
import type {
  Intervention as InterventionRow,
  Observation as ObservationRow,
  Prisma,
  Session as SessionRow,
} from '@prisma/client'

import { prisma } from '../lib/prisma.js'
import { toApiInterventions, toApiObservations } from '../lib/rows.js'
import { childLogger } from '../logger.js'
import { countSignals, bindSession } from './signals.js'
import { toApiGoal } from './goal.js'

const log = childLogger({ module: 'session' })

/**
 * The session lifecycle: one row per stretch of a person and a desk working
 * together, and the roll-up that says what happened in it.
 *
 * Three decisions shape this file, and all three are about *not* trusting
 * something that is already in the database:
 *
 *   - **`Session.summary` is a legacy blob.** The seed writes
 *     `{ durationMs, focusedMinutes, offTaskMinutes, observations, interventions,
 *     longestFocusRunSeconds, tierHistogram }` into it; the contract's
 *     `SessionSummary` is `{ focusedMinutes, offTaskMinutes,
 *     longestFocusRunSeconds, topDistraction, worked, message }`. Passing the
 *     stored blob through fails the response serializer, so every read of the
 *     seeded session would be a 500. The roll-up is therefore **derived from the
 *     rows** — observations and interventions are the truth, the column is a
 *     cache that this file fills in and never reads.
 *   - **The seed also disagrees with itself**: it claims 34 focused minutes and
 *     a 540 s longest run, while its own twenty windows sum to 964 s focused /
 *     314 s off-task with a longest run of 464 s. Deriving the roll-up from the
 *     rows makes `GET /v1/sessions/:id` agree with `GET /v1/analytics/summary`
 *     (HELI-018), which reads the same windows. A session's own screen and the
 *     dashboard cannot show two different numbers for one session.
 *   - **An open session reports `durationMs: null` and no summary.** Both would
 *     otherwise change on every read, and a client that stored one would be
 *     storing a number that was already wrong.
 *
 * Two things it deliberately does *not* do:
 *
 *   - It does not call `endSignalSession` or `endMediaSession` on close. The
 *     signal ring and the media hub are process-local state that outlives a
 *     session on purpose: the closing client is about to read the windows that
 *     were built from them, and dropping the ring first would lose exactly the
 *     numbers it came for.
 *   - It does not invent a `CloseSessionResponse`. `packages/contracts` has
 *     none, so `POST /v1/sessions/:id/close` answers the contract's `Session`.
 *     That is a local choice, not a shape from the contract — see
 *     `routes/sessions.ts`.
 */

/* ---- row to contract ----------------------------------------------------- */

/** A session row with the goal joined on, which every read here needs. */
type SessionWithGoal = Prisma.SessionGetPayload<{ include: { goal: true } }>

/** The rows a session is made of, already mapped into contract shapes. */
interface Children {
  observations: ApiObservation[]
  interventions: ApiIntervention[]
}

/** Everything about a session that is *not* a column on it. */
interface Rollup {
  signalCount: number
  observationCount: number
  interventionCount: number
  tierHistogram: Record<string, number>
  summary: SessionSummary | null
}

const EMPTY_CHILDREN: Children = { observations: [], interventions: [] }

const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode })

/**
 * The contract wants a duration in milliseconds, `Int` and non-negative; the
 * table stores two timestamps and nothing else, so the difference is computed
 * here. An open session answers `null` rather than a number that grows while a
 * client is holding it — the contract makes the field nullable for exactly this
 * case.
 *
 * Clamped at zero: `endedAt < startedAt` is a clock or a hand-written row, and a
 * negative duration would fail the serializer.
 */
const durationOf = (row: SessionRow): number | null =>
  row.endedAt === null ? null : Math.max(0, row.endedAt.getTime() - row.startedAt.getTime())

/**
 * `signalCount` is **process-local** and honestly so: signals are never
 * persisted (there is no signal table — HELI-015 keeps a bounded ring in
 * memory), so this is `countSignals` from `services/signals.ts` and it resets to
 * zero when the server restarts. `observationCount` and `interventionCount` come
 * from rows and do not.
 */
export function toApiSession(row: SessionRow, rollup: Rollup): ApiSession {
  return {
    id: row.id,
    deviceId: row.deviceId,
    // Required in Prisma (`Session.goalId` has no `?`), nullable in the
    // contract. The column is the narrower of the two, so this is a widening
    // that cannot lose anything; the `?? null` is for the type, not a case that
    // happens.
    goalId: row.goalId ?? null,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: durationOf(row),
    signalCount: rollup.signalCount,
    observationCount: rollup.observationCount,
    interventionCount: rollup.interventionCount,
    tierHistogram: rollup.tierHistogram,
    summary: rollup.summary,
  }
}

/* ---- the roll-up --------------------------------------------------------- */

/** One decimal, as `services/analytics.ts` rounds. */
const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * A focus window is one the model judged on task and that was not a break —
 * the same rule as `services/analytics.ts#countsAsFocus` and the desktop's
 * `derive()`. A break is an instructed absence, not focus, and counting it as
 * one would inflate the very number the user is trying to raise. An observation
 * with no assessment (the model was unreachable) breaks a run for the same
 * reason: it is not evidence of focus.
 */
const countsAsFocus = (observation: ApiObservation): boolean => {
  const assessment = observation.assessment
  if (!assessment || !assessment.onTask) return false
  return assessment.activity !== 'break'
}

/** `{ tier: count }`, the keys the contract's `z.record` means. Tier 0 included. */
function histogramOf(observations: ApiObservation[]): Record<string, number> {
  const histogram: Record<string, number> = {}
  for (const observation of observations) {
    const key = String(observation.tier)
    histogram[key] = (histogram[key] ?? 0) + 1
  }
  return histogram
}

/** The goal, in one noun, for the summary line. `"Finish the linear algebra problem set"` → `linear algebra problem set`. */
const goalNoun = (goal: ApiGoal): string =>
  goal.objective.replace(/^(finish|write|do|complete)\s+(the\s+)?/i, '').toLowerCase()

/**
 * The contract's `SessionSummary`, folded out of the session's own windows and
 * observations.
 *
 * The desktop's history reads `message`, `topDistraction` and `worked` from it.
 */
function summarise(observations: ApiObservation[], goal: ApiGoal): SessionSummary {
  let focusedSeconds = 0
  let offTaskSeconds = 0
  let run = 0
  let longestRunSeconds = 0
  const distraction = new Map<string, number>()
  const worked = new Map<string, { tier: number; outcome: string; count: number }>()

  for (const observation of observations) {
    const { signals } = observation
    focusedSeconds += signals.focusedSeconds
    offTaskSeconds += signals.offTaskSeconds

    if (countsAsFocus(observation)) {
      run += signals.focusedSeconds
      longestRunSeconds = Math.max(longestRunSeconds, run)
    } else {
      run = 0
    }

    const assessment = observation.assessment
    if (assessment && !assessment.onTask) {
      // What was in the way, named the way the person would name it: the site if
      // the window had one, else the phone if the model called it that, else the
      // app.
      const key =
        signals.topSites[0]?.title ??
        (assessment.kind === 'phone' ? 'Phone' : (signals.topApps[0]?.app ?? 'Unknown'))
      distraction.set(key, (distraction.get(key) ?? 0) + signals.offTaskSeconds)
    }

    // "What the system did", from the outcome the observation resolved to. An
    // intervention nobody judged yet (a null outcome) is not counted, because
    // `worked` is a claim about what worked.
    if (observation.tier > 0 && observation.outcome !== null) {
      const id = `${observation.tier}:${observation.outcome}`
      const row = worked.get(id) ?? { tier: observation.tier, outcome: observation.outcome, count: 0 }
      row.count += 1
      worked.set(id, row)
    }
  }

  const top = [...distraction.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const focusedMinutes = round(focusedSeconds / 60, 1)
  const offTaskMinutes = round(offTaskSeconds / 60, 1)
  const loud = observations.filter((observation) => observation.tier >= 2)
  const landed = loud.filter((observation) => observation.outcome === 'resolved')

  return {
    focusedMinutes,
    offTaskMinutes,
    longestFocusRunSeconds: longestRunSeconds,
    topDistraction: top,
    worked: [...worked.values()].sort(
      (a, b) => a.tier - b.tier || a.outcome.localeCompare(b.outcome),
    ),
    message:
      loud.length === 0
        ? `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(goal)}. Nothing needed saying.`
        : `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(goal)}. ${landed.length} of ${loud.length} interruptions brought you back.`,
  }
}

/**
 * Everything a session carries that is not a column: the counts, the histogram
 * and — for a **closed** session only — the summary.
 *
 * The counts are taken from the *mapped* children rather than from
 * `prisma.observation.count`, so `SessionDetail.observations.length` always
 * equals `observationCount` and a client can never render "20 windows" beside a
 * list of 19. `rows.ts` drops a row it cannot read as a contract shape and logs
 * it; when that happens the two counts are no longer the raw row counts, which
 * is logged here so the difference is visible instead of arithmetic-looking.
 */
function rollupOf(row: SessionRow, children: Children, goal: ApiGoal): Rollup {
  return {
    signalCount: countSignals(row.id),
    observationCount: children.observations.length,
    interventionCount: children.interventions.length,
    tierHistogram: histogramOf(children.observations),
    summary: row.endedAt === null ? null : summarise(children.observations, goal),
  }
}

/* ---- reads --------------------------------------------------------------- */

/**
 * The observations and interventions of several sessions in two queries.
 *
 * `GET /v1/sessions` is on the desktop's startup path (`live.attach()` calls it
 * before it attaches to anything), so this is deliberately not a query per
 * session: one `findMany` with an `in` list each, grouped in memory.
 *
 * Order is oldest first within a session, which is the order the console and the
 * web's strip both draw.
 */
async function childrenOf(sessionIds: string[]): Promise<Map<string, Children>> {
  const bySession = new Map<string, Children>()
  if (sessionIds.length === 0) return bySession

  const [observationRows, interventionRows] = await Promise.all([
    prisma.observation.findMany({
      where: { sessionId: { in: sessionIds } },
      orderBy: { ts: 'asc' },
    }),
    prisma.intervention.findMany({
      where: { sessionId: { in: sessionIds } },
      orderBy: { firedAt: 'asc' },
    }),
  ])

  const raw = new Map<string, { observations: ObservationRow[]; interventions: InterventionRow[] }>()
  const bucketFor = (sessionId: string) => {
    let bucket = raw.get(sessionId)
    if (bucket === undefined) {
      bucket = { observations: [], interventions: [] }
      raw.set(sessionId, bucket)
    }
    return bucket
  }
  for (const row of observationRows) bucketFor(row.sessionId).observations.push(row)
  for (const row of interventionRows) bucketFor(row.sessionId).interventions.push(row)

  for (const sessionId of sessionIds) {
    const bucket = raw.get(sessionId) ?? { observations: [], interventions: [] }
    const observations = toApiObservations(bucket.observations)
    const interventions = toApiInterventions(bucket.interventions)

    if (observations.length !== bucket.observations.length) {
      log.warn(
        { sessionId, rows: bucket.observations.length, readable: observations.length },
        'some observations are not readable as contract shapes; the roll-up counts what it can read',
      )
    }
    if (interventions.length !== bucket.interventions.length) {
      log.warn(
        { sessionId, rows: bucket.interventions.length, readable: interventions.length },
        'some interventions are not readable as contract shapes; the roll-up counts what it can read',
      )
    }

    bySession.set(sessionId, { observations, interventions })
  }

  return bySession
}

/** One session, everything it is made of, in contract shapes. */
interface SessionBundle {
  session: ApiSession
  goal: ApiGoal
  observations: ApiObservation[]
  interventions: ApiIntervention[]
}

async function bundlesFor(rows: SessionWithGoal[]): Promise<SessionBundle[]> {
  const children = await childrenOf(rows.map((row) => row.id))

  return rows.map((row) => {
    // `Session.goalId` is required, so the join always resolves; a goal that was
    // deleted out from under a session is not a state this schema allows.
    const goal = toApiGoal(row.goal)
    const kids = children.get(row.id) ?? EMPTY_CHILDREN
    return {
      session: toApiSession(row, rollupOf(row, kids, goal)),
      goal,
      observations: kids.observations,
      interventions: kids.interventions,
    }
  })
}

/** Newest first. Includes the sessions that are still open (`endedAt: null`). */
export async function listSessions(): Promise<ApiSession[]> {
  const rows = await prisma.session.findMany({
    include: { goal: true },
    orderBy: { startedAt: 'desc' },
  })
  return (await bundlesFor(rows)).map((bundle) => bundle.session)
}

/**
 * One session with its goal, its observations and its interventions, or `null`
 * when there is no such row — the caller answers that as a 404.
 */
export async function getSessionDetail(id: string): Promise<SessionDetail | null> {
  const row = await prisma.session.findUnique({ where: { id }, include: { goal: true } })
  if (row === null) return null

  const [bundle] = await bundlesFor([row])
  if (bundle === undefined) return null

  return {
    ...bundle.session,
    goal: bundle.goal,
    observations: bundle.observations,
    interventions: bundle.interventions,
  }
}

/** Whether a session id exists at all. Used by the window route to answer 404. */
export async function sessionExists(id: string): Promise<boolean> {
  const row = await prisma.session.findUnique({ where: { id }, select: { id: true } })
  return row !== null
}

/* ---- lifecycle ----------------------------------------------------------- */

export interface OpenSessionInput {
  /** Absent means "the machine on this server" — one seeded user, one machine. */
  deviceId?: string
  goalId: string | null
}

/**
 * `openSession` — the REST route (HELI-013) and the desktop's start-of-session
 * call, so there is one answer to what opening a session means.
 *
 * `goalId: null` means "whatever goal is active", which is the nullability §7
 * has in `OpenSessionRequest` while `Session.goalId` is required in the schema.
 * A session always has a goal, so a null is resolved rather than stored. With
 * nothing active to resolve it to, the answer is a **409**, not a 500 and not a
 * goal invented out of the request.
 *
 * Which *active* goal a null resolves to, when several are active, is product
 * behaviour the phase doc does not state — so it is the oldest active goal,
 * which is stable and never changes under a desktop that reconnects.
 */
export async function openSession(input: OpenSessionInput): Promise<OpenSessionResponse> {
  // Checked first, and by hand: `Session.deviceId` is a required foreign key, so
  // an unpaired device id would otherwise be a P2003 — a 500 — instead of "that
  // device does not exist". No id means the seeded machine: the desktop no
  // longer lists devices, because there is exactly one.
  const device =
    input.deviceId === undefined
      ? await prisma.device.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      : await prisma.device.findUnique({
          where: { id: input.deviceId },
          select: { id: true },
        })
  if (device === null) {
    throw httpError(
      404,
      input.deviceId === undefined
        ? 'No device is registered on this server. Seed one with `pnpm --filter @heli/server db:seed`.'
        : `No device ${input.deviceId}.`,
    )
  }

  const goalRow =
    input.goalId === null
      ? await prisma.goal.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } })
      : await prisma.goal.findUnique({ where: { id: input.goalId } })

  if (goalRow === null) {
    // Two different statements, two different answers: an id nobody has is a
    // 404, while "the goal set is empty" is a conflict with the current state of
    // the database rather than a missing resource.
    if (input.goalId === null) {
      throw httpError(
        409,
        'No active goal to open a session against. Create one with POST /v1/goals first.',
      )
    }
    throw httpError(404, `No goal ${input.goalId}.`)
  }

  const row = await prisma.session.create({
    data: { goalId: goalRow.id, deviceId: device.id },
    include: { goal: true },
  })

  /**
   * The device is bound to the session it just opened, so a signal that arrives
   * with a null `sessionId` — a desktop that has not read the response yet, or
   * an offline flush on the next boot — is attributed to this session instead of
   * being counted and dropped (HELI-015's `bindSession`).
   */
  bindSession(device.id, row.id)

  const goal = toApiGoal(row.goal)
  const session = toApiSession(row, rollupOf(row, EMPTY_CHILDREN, goal))

  log.info({ sessionId: row.id, deviceId: device.id, goalId: goal.id }, 'session opened')
  return { session, goal, policy: goal.policy }
}

export interface CloseSessionInput {
  sessionId: string
  reason?: string
}

/**
 * `closeSession` stamps `endedAt`, computes the roll-up, and answers the session.
 *
 * The roll-up is written into `Session.summary` as the contract
 * `SessionSummary` — so a freshly closed session's column stops holding the
 * legacy shape the seed wrote — **and** recomputed on every read. The column is
 * a cache; the rows are the truth. The write is not what any response is built
 * from.
 *
 * Closing an already-closed session is **idempotent**: the original `endedAt` is
 * kept and the same session comes back. A retry after a dropped response must
 * not move the end of a session, and the roll-up is a pure fold over rows that
 * did not change.
 *
 * `reason` has nowhere to go. §7's `CloseSessionRequest` carries one, but
 * neither the `Session` model nor the contract's `Session` has a field for it,
 * so it is logged and dropped rather than smuggled into a column that means
 * something else.
 */
export async function closeSession(input: CloseSessionInput): Promise<ApiSession> {
  const row = await prisma.session.findUnique({ where: { id: input.sessionId }, include: { goal: true } })
  if (row === null) throw httpError(404, `No session ${input.sessionId}.`)

  const goal = toApiGoal(row.goal)
  const children = (await childrenOf([row.id])).get(row.id) ?? EMPTY_CHILDREN

  if (row.endedAt !== null) {
    log.info(
      { sessionId: row.id, reason: input.reason },
      'session was already closed; leaving endedAt where it was',
    )
    return toApiSession(row, rollupOf(row, children, goal))
  }

  const endedAt = new Date()
  // Computed here for the column; `rollupOf` recomputes the same value for the
  // response. It is a pure fold over the same rows, so the two cannot disagree.
  const summary = summarise(children.observations, goal)

  const closed = await prisma.session.update({
    where: { id: row.id },
    data: { endedAt, summary },
    include: { goal: true },
  })

  log.info(
    {
      sessionId: closed.id,
      reason: input.reason,
      durationMs: durationOf(closed),
      observations: children.observations.length,
      interventions: children.interventions.length,
    },
    'session closed',
  )

  return toApiSession(closed, rollupOf(closed, children, goal))
}
