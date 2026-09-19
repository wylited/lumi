import type { LiveEvent } from '@heli/contracts'

import type { Env } from '../env.js'
import { createVisionProvider } from '../models/provider.js'
import { createSpeechProvider } from '../voice/speech.js'
import { createTransport } from '../voice/transport.js'
import { createPrismaLoop, type PrismaLoopInput } from './persistence.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import type { Loop } from './index.js'

/**
 * Assembles the loop from the things only the server can provide: the sockets,
 * the database and the environment.
 *
 * Everything below is injected rather than imported, so this file — and the
 * loop behind it — never depends on the websocket registry, the desktop socket
 * or fastify. The server owner's whole integration is one call.
 */

/** Where a line goes. The desktop is tried first; the desk is the fallback. */
export interface LoopSenders {
  /** JSON to a session, for example the `audio.out` header. */
  sendToSession(sessionId: string, payload: unknown): boolean
  /** Tagged binary to a session. Absent means audio cannot reach the desk yet. */
  sendBinaryToSession?(sessionId: string, bytes: Buffer): boolean
  /** A tier-2 notification, with an action, where the person actually is. */
  sendNotification(sessionId: string, message: string): boolean
}

export interface LoopRuntimeInput {
  env: Env
  senders: LoopSenders
  /** Every session the scheduler should assess. */
  activeSessions: () => Promise<string[]>
  /** The SSE fan-out. */
  publish: (sessionId: string, event: LiveEvent) => void
  automate?: PrismaLoopInput['automate']
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

  const transport = createTransport({
    sendToSession: (sessionId, payload) => input.senders.sendToSession(sessionId, payload),
    sendBinaryToSession: (sessionId, bytes) =>
      input.senders.sendBinaryToSession ? input.senders.sendBinaryToSession(sessionId, bytes) : false,
    sendNotification: (sessionId, message) =>
      input.senders.sendNotification(sessionId, message),
  })

  const loop = createPrismaLoop({
    prisma: input.prisma,
    bus: { publish: input.publish },
    transport,
    vision,
    speech,
    logger: input.logger,
    automate: input.automate,
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
