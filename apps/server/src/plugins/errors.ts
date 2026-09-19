import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

/**
 * The single error envelope for this server: `{ error, issues? }`, and never a
 * stack trace. `issues` is present only for a failed request validation, and is
 * normalised to `{ path, message, code }` with a dotted path, so a form can map
 * an issue straight onto a field.
 *
 * The request id travels as the `x-request-id` response header instead of a
 * third body key, so the documented envelope stays exactly as wide as the phase
 * doc says it is.
 */
export interface ErrorIssue {
  path: string
  message: string
  code: string
}

export interface ErrorBody {
  error: string
  issues?: ErrorIssue[]
}

const normaliseIssues = (error: ZodError): ErrorIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }))

// Fastify types a handler error as `unknown` on purpose, so narrow it here
// rather than asserting a shape we do not control.
const statusOf = (error: unknown): number => {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const { statusCode } = error as { statusCode?: unknown }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
      return statusCode
    }
  }
  return 500
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Internal server error'

export function applyErrors(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .header('x-request-id', request.id)
      .send({ error: `No route for ${request.method} ${request.url}` } satisfies ErrorBody)
  })

  // A zod validation failure arrives here as the ZodError itself: fastify's
  // wrapValidationError leaves an Error instance alone and only stamps it with
  // statusCode 400, code FST_ERR_VALIDATION and validationContext ('body',
  // 'querystring', 'params' or 'headers').
  app.setErrorHandler((error, request, reply) => {
    const issues = error instanceof ZodError ? normaliseIssues(error) : undefined
    const status = issues ? 400 : statusOf(error)

    if (status >= 500) {
      // The stack and the original message go to the log, and only to the log.
      request.log.error({ err: error, statusCode: status }, 'request failed')
    } else {
      request.log.warn({ err: error, statusCode: status }, 'request rejected')
    }

    const body: ErrorBody = issues
      ? { error: 'Validation failed', issues }
      : { error: status >= 500 ? 'Internal server error' : messageOf(error) }

    void reply.code(status).header('x-request-id', request.id).send(body)
  })
}
