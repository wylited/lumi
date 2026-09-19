import { z } from 'zod'

export const Policy = z.object({
  windowMs: z.number().int().default(60_000),
  assessEveryMs: z.number().int().default(10_000),
  minConfidence: z.number().min(0).max(1).default(0.7),
  driftSeconds: z.number().int().default(30),
  consecutiveOffGoal: z.number().int().default(2),
  nudgeGapMs: z.number().int().default(180_000),
  minGapMs: z.number().int().default(90_000),
  maxTier: z.number().int().min(0).max(5).default(2),
  resolveWindowMs: z.number().int().default(120_000),
  revertWindowMs: z.number().int().default(60_000),
  maxAutomationsPerSession: z.number().int().default(6),
  assumeSilentOnDoubt: z.boolean().default(true),
})

export type Policy = z.infer<typeof Policy>

export const DEFAULT_POLICY: Policy = Policy.parse({})
