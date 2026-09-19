import { randomUUID } from 'node:crypto'

import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import websocket from '@fastify/websocket'
import fastify from 'fastify'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'

import { logger } from './logger.js'
import { applyErrors } from './plugins/errors.js'
import { registerHealth } from './plugins/health.js'
import { registerRoutes } from './plugins/routes.js'
import { applyZod } from './plugins/zod.js'

/**
 * Builds the server without listening, so tests and the dev mocks can drive it.
 *
 * The zod compilers and the error handler are installed on the root instance
 * rather than from inside a plugin: a fastify plugin gets its own encapsulation
 * context, and both of those only apply to routes registered in the same
 * context. Installing them here is what makes them reach every route file the
 * folder loader picks up.
 */
export async function buildServer(): Promise<FastifyInstance> {
  // Annotated as FastifyServerOptions so the instance keeps the default
  // FastifyBaseLogger type parameter. Passing `loggerInstance: logger` alone
  // would parameterise the instance with pino's narrower `Logger`, and then no
  // helper -- or later route file -- that takes a plain `FastifyInstance` would
  // accept it.
  const options: FastifyServerOptions = {
    loggerInstance: logger,
    // A uuid rather than fastify's counter, so a request id is traceable across
    // the device socket, the SSE stream and the desktop app's own logs.
    genReqId: () => randomUUID(),
  }

  const app = fastify(options)

  await app.register(cors, {
    // Dev-only: the Tauri webview and the Next.js app are separate origins.
    origin: true,
    exposedHeaders: ['x-request-id'],
  })
  await app.register(sensible)
  await app.register(websocket)

  applyZod(app)
  applyErrors(app)

  registerHealth(app)
  await registerRoutes(app)

  return app
}
