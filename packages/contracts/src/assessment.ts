import { z } from 'zod'

export const ActivityKind = z.string()
export type ActivityKind = z.infer<typeof ActivityKind>

export const Assessment = z.object({
  onTask: z.boolean(),
  activity: ActivityKind,
  kind: z.string().nullable(),
  driftSeconds: z.number().int().nonnegative(),
  evidence: z.array(z.string().max(140)).max(5),
  confidence: z.number().min(0).max(1),
  because: z.string().max(200),
})
export type Assessment = z.infer<typeof Assessment>
