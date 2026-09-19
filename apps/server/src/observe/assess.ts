import { Assessment } from '@heli/contracts'

import type { AssessInput, VisionProvider } from './types.js'

export interface AssessLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface AssessDeps {
  vision: VisionProvider
  logger: AssessLogger
}

/**
 * The assess step. It is intentionally thin: call the provider, hold its output
 * to the frozen schema, log what came back. The orchestrator owns the cadence,
 * the frame fetching, the policy and the budget. A provider that cannot produce
 * a valid Assessment throws, so the caller can record silence.
 */
export async function assess(input: AssessInput, deps: AssessDeps): Promise<Assessment> {
  const started = Date.now()
  const proposed = await deps.vision.assess(input)

  const parsed = Assessment.safeParse(proposed)
  if (!parsed.success) {
    deps.logger.error(
      { provider: deps.vision.name, issues: parsed.error.issues },
      'vision.assess.invalid',
    )
    throw new Error(`vision provider ${deps.vision.name} returned an invalid assessment`)
  }

  deps.logger.info(
    {
      provider: deps.vision.name,
      latencyMs: Date.now() - started,
      onTask: parsed.data.onTask,
      activity: parsed.data.activity,
      kind: parsed.data.kind,
      confidence: parsed.data.confidence,
    },
    'vision.assess',
  )

  return parsed.data
}
