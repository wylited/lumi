import type { ZodType, input, output } from 'zod'

/**
 * Every Fastify instance in this package is zod-typed by default, so a route
 * declares `schema: { body: GoalCreateRequest }` with a schema out of
 * `@heli/contracts` and gets `request.body` inferred from it.
 *
 * Owned by HELI-010, repaired by HELI-020. A later commit that adds a decorator
 * (`requireUser`, `requireMobile`) declares its own `declare module 'fastify'`
 * block inside the file that implements it, so it never has to edit this one.
 *
 * Why the members are written out instead of `extends ZodTypeProvider {}`:
 * Fastify resolves a route's `request.body` through
 * `(TypeProvider & { schema: SchemaCompiler['body'] })['validator']`, so the
 * conditional has to survive onto `FastifyTypeProviderDefault` itself. An
 * `extends ZodTypeProvider` clause does not do that — the base interface's
 * `validator: unknown` (from `FastifyTypeProvider`) wins, every route generic
 * collapses to `unknown`, and `request.body.someField` becomes a compile error
 * on a route whose schema declares exactly that field. Declaring the members in
 * the body of the merged interface makes them override the inherited
 * `unknown`, while `plugins/zod.ts` keeps exporting the standalone
 * `ZodTypeProvider` for anyone who reaches for `withTypeProvider`.
 */
declare module 'fastify' {
  interface FastifyTypeProviderDefault {
    readonly validator: this['schema'] extends ZodType ? output<this['schema']> : unknown
    readonly serializer: this['schema'] extends ZodType ? input<this['schema']> : unknown
  }
}
