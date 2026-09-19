import type { ZodTypeProvider } from '../plugins/zod.js'

/**
 * Every Fastify instance in this package is zod-typed by default, so a route
 * declares `schema: { body: GoalCreateRequest }` with a schema out of
 * `@heli/contracts` and gets `request.body` inferred from it.
 *
 * Owned by HELI-010. A later commit that adds a decorator (`requireUser`,
 * `requireDevice`) declares its own `declare module 'fastify'` block inside the
 * file that implements it, so it never has to edit this one.
 */
declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Fastify's documented way to replace the default type provider is an empty extending interface
  interface FastifyTypeProviderDefault extends ZodTypeProvider {}
}
