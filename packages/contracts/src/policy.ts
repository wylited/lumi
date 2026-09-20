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
  surveyFloorMs: z.number().int().default(1_200_000),
  surveyGapMs: z.number().int().default(300_000),
  clutterSpeakScore: z.number().min(0).max(1).default(0.6),
  // Two readings of one desk are not one number: three frames of an unchanged
  // desk scored 0.32 and 0.45 minutes apart on the bench, so "worse than last
  // time" has to sit above that spread or the noise is what speaks.
  clutterRiseDelta: z.number().min(0).max(1).default(0.25),
  clutterGapMs: z.number().int().default(2_700_000),
})

export type Policy = z.infer<typeof Policy>

export const DEFAULT_POLICY: Policy = Policy.parse({})
