import { env } from './env.js'
import { logger } from './logger.js'
import { buildServer } from './server.js'

const app = await buildServer()

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down')
  try {
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
