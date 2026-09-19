import { z } from 'zod'
import { Automation } from './goal.js'

export const Tier = z.number().int().min(0).max(5)
export type Tier = z.infer<typeof Tier>

export const Outcome = z.enum(['resolved', 'ignored', 'reverted', 'unknown'])
export type Outcome = z.infer<typeof Outcome>

export const InterventionChannel = z.enum([
  'log',
  'ambient',
  'notification',
  'speech',
  'automation',
  'summary',
])
export type InterventionChannel = z.infer<typeof InterventionChannel>

export const Intervention = z.object({
  tier: Tier,
  channel: InterventionChannel,
  message: z.string().max(220).nullable(),
  action: Automation.nullable(),
  reversible: z.boolean(),
  reason: z.string(),
})
export type Intervention = z.infer<typeof Intervention>
