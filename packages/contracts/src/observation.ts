import { z } from 'zod'
import { SignalWindow } from './signal.js'
import { Assessment } from './assessment.js'
import { Tier, Outcome, Intervention } from './intervention.js'

export const ObservationRow = z.object({
  sessionId: z.string(),
  ts: z.string(),
  signals: SignalWindow,
  assessment: Assessment.nullable(),
  tier: Tier,
  action: Intervention.nullable(),
  outcome: Outcome.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  reason: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
})
export type ObservationRow = z.infer<typeof ObservationRow>

export const Observation = ObservationRow.extend({
  id: z.string(),
})
export type Observation = z.infer<typeof Observation>
