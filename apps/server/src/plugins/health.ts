import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

/**
 * Liveness only: no database, no provider, no key. It answers "the server is
 * up", which is what the RUNBOOK, the desktop app and HELI-010's `Done when`
 * all need — it is not a readiness probe for the dependencies.
 *
 * It is also the smallest honest proof that the zod provider works: the
 * response goes through the zod serializer compiler on its way out.
 */
const HealthResponse = z.object({ ok: z.literal(true) })
type HealthResponse = z.infer<typeof HealthResponse>

export function registerHealth(app: FastifyInstance): void {
  app.get(
    '/healthz',
    { schema: { response: { 200: HealthResponse } } },
    async (): Promise<HealthResponse> => ({ ok: true }),
  )
}
