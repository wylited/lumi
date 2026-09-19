import { env } from './env.js'
import { publish } from './lib/bus.js'
import { prisma } from './lib/prisma.js'
import { childLogger, logger } from './logger.js'
import { visionProviderName } from './models/provider.js'
import type { DeskSocketLookup } from './observe/outbound.js'
import {
  createLoopRuntime,
  DEFAULT_ASSESS_INTERVAL_MS,
  type LoopRuntime,
} from './observe/runtime.js'
import { buildServer } from './server.js'

const app = await buildServer()

const loopLog = childLogger({ module: 'observe.runtime' })

/**
 * Where a line goes.
 *
 * `observe/outbound.ts` builds the senders from one lookup — session id in, the
 * live desk socket out — and **nothing in the tree can answer it yet**: the desk
 * socket is HELI-044's, and the desktop socket keeps its connections private
 * behind no session index. Until one of them exposes the lookup, every sender
 * answers `false` and `createDeskSenders` logs each dropped line, which is the
 * honest report: a spoken line nobody heard is not a delivery. This constant is
 * the one line 044 replaces.
 */
const desk: DeskSocketLookup = () => null

/** Every session being watched right now. The loop assesses only these. */
const activeSessions = async (): Promise<string[]> => {
  const rows = await prisma.session.findMany({
    where: { endedAt: null },
    select: { id: true },
    orderBy: { startedAt: 'desc' },
  })
  return rows.map((row) => row.id)
}

/**
 * The loop, started.
 *
 * It is built inside a `try`: the vision adapter, the speech adapter and the
 * prisma-backed loop all resolve at boot, and a box with no model key and no
 * database must still serve HTTP. A failure here is logged and the server keeps
 * running — the rig's uploads matter more than the assessment cadence.
 */
let runtime: LoopRuntime | null = null

try {
  runtime = createLoopRuntime({
    env,
    desk,
    activeSessions,
    publish,
    logger: loopLog,
  })
  loopLog.info(
    { vision: visionProviderName(env), speech: env.SPEECH_PROVIDER, intervalMs: DEFAULT_ASSESS_INTERVAL_MS },
    'observe loop: runtime built',
  )
  if (visionProviderName(env) === 'local') {
    loopLog.warn('observe loop: no vision key, the offline assessor is deciding')
  }
} catch (error) {
  loopLog.error({ err: error }, 'observe loop: could not be built; serving without it')
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down')
  try {
    runtime?.scheduler.stop()
    await app.close()
    process.exit(0)
  } catch (error) {
    logger.error({ err: error }, 'failed to shut down cleanly')
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
  })
}

try {
  // 0.0.0.0, not 127.0.0.1: the Pi and the desktop app reach this box over the
  // LAN, and the device contract pairs against a host the device can dial.
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
} catch (error) {
  app.log.error({ err: error }, 'failed to start the server')
  process.exit(1)
}

/**
 * Started only after the listen succeeded, so a process that failed to bind does
 * not assess a single window on its way out. `scheduler.start()` is idempotent;
 * the probes below are the boot's own account of what it is watching.
 */
runtime?.scheduler.start()

try {
  const watching = await activeSessions()
  loopLog.info({ sessions: watching.length, intervalMs: DEFAULT_ASSESS_INTERVAL_MS }, 'observe loop: watching open sessions')
} catch (error) {
  loopLog.warn({ err: error }, 'observe loop: open sessions unavailable at boot')
}
