import { z } from 'zod'
import { Goal } from './goal.js'
import { Observation } from './observation.js'
import { Intervention } from './intervention.js'

export const SessionSummary = z.object({
  focusedMinutes: z.number().nonnegative(),
  offTaskMinutes: z.number().nonnegative(),
  longestFocusRunSeconds: z.number().nonnegative(),
  topDistraction: z.string().nullable(),
  worked: z.array(
    z.object({
      tier: z.number().int().min(0).max(5),
      outcome: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  message: z.string().nullable(),
})
export type SessionSummary = z.infer<typeof SessionSummary>

export const Session = z.object({
  id: z.string(),
  deviceId: z.string(),
  goalId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  signalCount: z.number().int().nonnegative(),
  observationCount: z.number().int().nonnegative(),
  interventionCount: z.number().int().nonnegative(),
  tierHistogram: z.record(z.number().int().nonnegative()),
  summary: SessionSummary.nullable(),
})
export type Session = z.infer<typeof Session>

export const SessionDetail = Session.extend({
  goal: Goal.nullable(),
  observations: z.array(Observation),
  interventions: z.array(Intervention),
})
export type SessionDetail = z.infer<typeof SessionDetail>
