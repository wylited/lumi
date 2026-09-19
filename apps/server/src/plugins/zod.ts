import type { FastifyInstance, FastifyTypeProvider } from 'fastify'
import { z } from 'zod'
import type { ZodType } from 'zod'

/**
 * A zod-backed type provider, hand-rolled on purpose: adding
 * `fastify-type-provider-zod` would be a new dependency and AGENTS.md wants a
 * `chore(repo):` commit with a justification before one appears.
 *
 * `src/types/fastify.d.ts` makes this the default provider, so a route declares
 * `schema: { body: GoalCreateRequest }` with a schema straight out of
 * `@heli/contracts` and gets `request.body` inferred. No hand-written types.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends ZodType ? z.output<this['schema']> : unknown
  serializer: this['schema'] extends ZodType ? z.input<this['schema']> : unknown
}

const isZodType = (schema: unknown): schema is ZodType => schema instanceof z.ZodType

/**
 * Installs the zod compilers on the instance it is handed. Call it on the root
 * instance, before any route is added, so every route file registered later
 * inherits them.
 *
 * A schema that is not a zod schema is a bug, not a request problem: this
 * throws, so it shows up at boot or at the first request for that route rather
 * than silently accepting anything.
 */
export function applyZod(app: FastifyInstance): void {
  app.setValidatorCompiler(({ schema }) => {
    if (!isZodType(schema)) {
      throw new Error('Every request schema must be a zod schema from @heli/contracts.')
    }
    return (data) => {
      const result = schema.safeParse(data)
      return result.success ? { value: result.data } : { error: result.error }
    }
  })

  app.setSerializerCompiler(({ schema }) => {
    if (!isZodType(schema)) {
      throw new Error('Every response schema must be a zod schema from @heli/contracts.')
    }
    return (data) => {
      const result = schema.safeParse(data)
      if (!result.success) {
        // A plain Error, not a ZodError: a response that does not match its own
        // schema is a server bug, so the error handler must answer 500.
        throw new Error(`A response did not match its schema: ${result.error.message}`)
      }
      return JSON.stringify(result.data)
    }
  })
}
