import { env } from './env.js'
import { publish } from './lib/bus.js'
import { prisma } from './lib/prisma.js'
import { childLogger, logger } from './logger.js'
import { createDesktopAutomate } from './observe/outbound.js'
import {
  createLoopRuntime,
  DEFAULT_ASSESS_INTERVAL_MS,
  type LoopRuntime,
} from './observe/runtime.js'
import { buildServer } from './server.js'
import { createLoopSenders, desktopSurface } from './voice/surfaces.js'

const app = await buildServer()

const loopLog = childLogger({ module: 'observe.runtime' })

/**
 * Where a line goes.
 *
 * Three surfaces, one routing rule, built in `voice/surfaces.ts` so the loop and
 * the manual `POST /v1/sessions/:id/speak` cannot disagree about it: the desktop
 * app is where the person sits and looks, the rig is on the same Mac and still
 * speaks when the app is not watching, and the phone is what they take with them.
 * `observe/outbound.ts` decides per line: speech follows the person when motion
 * says they left, a nudge prefers the phone, and everything falls back. With
 * nobody attached the lookup is `null`, the sender answers `false`, and the line
 * is recorded as undelivered — which is the honest report: a spoken line nobody
 * heard is not a delivery.
 */
const senders = createLoopSenders()

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
 * prisma-backed loop all resolve at boot. A missing key is an error naming it,
 * and the server still serves HTTP. A failure here is logged and the server keeps
 * running — the rig's uploads matter more than the assessment cadence.
 */
const automate = createDesktopAutomate(desktopSurface)

let runtime: LoopRuntime | null = null

try {
  runtime = createLoopRuntime({
    env,
    senders,
    activeSessions,
    publish,
    automate,
    logger: loopLog,
  })
  loopLog.info(
    { vision: 'deepseek', speech: 'elevenlabs', intervalMs: DEFAULT_ASSESS_INTERVAL_MS },
    'observe loop: runtime built',
  )
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
