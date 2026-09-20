import type { LiveEvent } from '@heli/contracts'

import type { Env } from '../env.js'
import { createVisionProvider } from '../models/provider.js'
import { buildAction, getTheDesk, isDeskConnected, issueAction } from '../services/desk.js'
import { createSpeechProvider } from '../voice/speech.js'
import { createTransport } from '../voice/transport.js'
import { createPrismaLoop, type PrismaLoopInput } from './persistence.js'
import { createDeskSenders, type DeskSocketLookup, type LoopSenders } from './outbound.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import type { Loop } from './index.js'
import type { DeskIssuer } from './types.js'

/**
 * Assembles the loop from the things only the server can provide: the sockets,
 * the database and the environment.
 *
 * Everything below is injected rather than imported, so this file — and the
 * loop behind it — never depends on the websocket registry, the desktop socket
 * or fastify. The server owner's whole integration is one call.
 */

export interface LoopRuntimeInput {
  env: Env
  /**
   * How the loop reaches a person. Give it a `desk` lookup and this file builds
   * the senders; give it `senders` and it uses them as-is, which is how a test
   * drives the whole runtime without a socket.
   */
  desk?: DeskSocketLookup
  /** The phone, when one is paired. Speech follows it only when `away` says so. */
  phone?: DeskSocketLookup
  /** True when the person is away from the desk — the phone's motion decides. */
  away?: (sessionId: string) => boolean
  senders?: LoopSenders
  /** Every session the scheduler should assess. */
  activeSessions: () => Promise<string[]>
  /** The SSE fan-out. */
  publish: (sessionId: string, event: LiveEvent) => void
  automate?: PrismaLoopInput['automate']
  /**
   * How the loop reaches the rig. Give this and the sweep path is drivable
   * without a socket; leave it and the real one is built from `services/desk.js`.
   */
  deskIssuer?: DeskIssuer
  frameBytes?: PrismaLoopInput['frameBytes']
  prisma?: PrismaLoopInput['prisma']
  intervalMs?: number
  logger: PrismaLoopInput['logger']
}

export interface LoopRuntime {
  loop: Loop
  scheduler: Scheduler
}

/** The default cadence: the policy's own `assessEveryMs`. */
export const DEFAULT_ASSESS_INTERVAL_MS = 10_000

export function createLoopRuntime(input: LoopRuntimeInput): LoopRuntime {
  const vision = createVisionProvider(input.env, input.logger)
  const speech = createSpeechProvider(input.env)
  const senders =
    input.senders ??
    createDeskSenders({
      desk: input.desk ?? (() => null),
      phone: input.phone,
      away: input.away,
      logger: input.logger,
    })

  const transport = createTransport({
    sendToSession: (sessionId, payload) => senders.sendToSession(sessionId, payload),
    sendBinaryToSession: (sessionId, bytes) =>
      senders.sendBinaryToSession ? senders.sendBinaryToSession(sessionId, bytes) : false,
    sendNotification: (sessionId, message) => senders.sendNotification(sessionId, message),
  })

  const loop = createPrismaLoop({
    prisma: input.prisma,
    bus: { publish: input.publish },
    transport,
    vision,
    speech,
    logger: input.logger,
    automate: input.automate,
    // The one desk the server knows, as the survey pass asks for it: asked for
    // each time because a rig reconnects, and `hasArm` because a sweep with no
    // arm is a single frame from where the camera already is.
    desk:
      input.deskIssuer ?? {
        theDesk: async () => {
          const desk = await getTheDesk()
          return desk === null
            ? null
            : { id: desk.id, connected: isDeskConnected(desk.id), hasArm: desk.arm !== null }
        },
        issue: (deskId, request) => issueAction(deskId, buildAction(request)),
      },
    frameBytes: input.frameBytes,
  })

  const scheduler = createScheduler({
    loop,
    activeSessions: input.activeSessions,
    intervalMs: input.intervalMs ?? DEFAULT_ASSESS_INTERVAL_MS,
    logger: input.logger,
  })

  return { loop, scheduler }
}
