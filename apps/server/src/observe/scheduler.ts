import type { Loop } from './index.js'

/**
 * Drives the loop on a cadence. The loop assesses one window when asked; the
 * scheduler decides *when* to ask, for every session that is open.
 *
 * Kept separate from the orchestrator so a test can step it by hand, and so the
 * server can wire it to whatever "the active sessions" means after a restart.
 */
export interface SchedulerDeps {
  loop: Loop
  /** The session ids worth assessing right now. */
  activeSessions: () => Promise<string[]>
  intervalMs: number
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

export interface Scheduler {
  /** One pass over every active session. Awaitable so tests can step it. */
  tick(): Promise<void>
  start(): void
  stop(): void
  readonly running: boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: NodeJS.Timeout | null = null
  let inTick = false

  async function tick(): Promise<void> {
    // A slow tick must not stack on the previous one.
    if (inTick) return
    inTick = true
    try {
      const sessions = await deps.activeSessions()
      for (const sessionId of sessions) {
        try {
          await deps.loop.runWindow(sessionId)
        } catch (error) {
          // One broken session never stops the others.
          deps.logger.error({ sessionId, err: error }, 'observe.scheduler: session tick failed')
        }
      }
    } catch (error) {
      deps.logger.error({ err: error }, 'observe.scheduler: tick failed')
    } finally {
      inTick = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, deps.intervalMs)
      // Do not hold the process open just for the loop.
      timer.unref?.()
      deps.logger.info({ intervalMs: deps.intervalMs }, 'observe.scheduler: started')
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
      deps.logger.info({}, 'observe.scheduler: stopped')
    },
    get running() {
      return timer !== null
    },
  }
}
