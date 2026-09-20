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
  /**
   * Desk millimetres to point at when the line comes with a gesture (`arm.point`).
   *
   * Absent on every line that carries no gesture, and only the desk survey sets it — a clutter
   * line on a calibrated desk points at the pile it is talking about. Optional rather than
   * `default(null)` on purpose: `Intervention` is the one contract with object literals of its
   * output type in TypeScript (`observe/policy.ts`, `lib/rows.ts`), and a default would make every
   * one of them a type error in the row that added this field.
   */
  point: z.object({ x: z.number(), y: z.number() }).strict().nullable().optional(),
})
export type Intervention = z.infer<typeof Intervention>
