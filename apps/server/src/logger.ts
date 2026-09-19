import { pino } from 'pino'
import type { Logger } from 'pino'

import { env } from './env.js'

// Never let a bearer token, provider key or voice token reach the log stream.
const redactPaths = [
  'authorization',
  'token',
  'apiKey',
  'voiceToken',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.authorization',
  '*.token',
  '*.apiKey',
  '*.voiceToken',
  '*.*.authorization',
  '*.*.token',
  '*.*.apiKey',
  '*.*.voiceToken',
]

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[redacted]',
  },
})

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings)
}
