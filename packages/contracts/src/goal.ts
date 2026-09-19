import { z } from 'zod'
import { Policy } from './policy.js'

export const GoalKind = z.enum(['study', 'work', 'life'])
export type GoalKind = z.infer<typeof GoalKind>

export const Permission = z.enum(['nudge', 'speak', 'automate'])
export type Permission = z.infer<typeof Permission>

export const Automation = z.enum([
  'pause_notifications',
  'open_app',
  'navigate_tab',
  'mute_site',
  'start_break',
  'start_timer',
])
export type Automation = z.infer<typeof Automation>

export const BreakPolicy = z.enum(['none', 'pomodoro_25_5', 'pomodoro_50_10', 'custom'])
export type BreakPolicy = z.infer<typeof BreakPolicy>

export const Goal = z.object({
  id: z.string(),
  kind: GoalKind,
  objective: z.string().min(1).max(280),
  successCriteria: z.string().max(280).nullable(),
  timeBudgetMinutes: z.number().int().positive().nullable(),
  breakPolicy: BreakPolicy.default('none'),
  allowedApps: z.array(z.string()).default([]),
  blockedApps: z.array(z.string()).default([]),
  allowedSites: z.array(z.string()).default([]),
  blockedSites: z.array(z.string()).default([]),
  permissions: z.array(Permission).default(['nudge', 'speak']),
  automations: z.array(Automation).default([]),
  policy: Policy,
  active: z.boolean().default(true),
  createdAt: z.string(),
})
export type Goal = z.infer<typeof Goal>
