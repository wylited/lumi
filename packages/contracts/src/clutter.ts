import { z } from 'zod'

/**
 * The desk survey: the model's second output, and the only shape a survey
 * verdict travels in.
 *
 * The assessment answers "is this person on task?" every window; this answers
 * "how cluttered is the desk?" rarely, once per sweep, from two to four frames
 * taken one after another across the desk. It is a reading and nothing else: it
 * never carries a line for the person, and the policy writes every spoken line
 * from `score` and `hotspots` the way it writes the drift lines from an
 * assessment. A desk with nothing on it is a low `score`, an empty `hotspots`.
 */

/** The kinds of thing a desk is cluttered with. Closed, unlike `ActivityKind`. */
export const ClutterLabel = z.enum([
  'papers',
  'cups',
  'dishes',
  'food',
  'cables',
  'clothes',
  'tools',
  'boxes',
  'bottles',
  'other',
])
export type ClutterLabel = z.infer<typeof ClutterLabel>

/** One place that makes the desk cluttered, and where it is in the frame it was seen in. */
export const ClutterHotspot = z
  .object({
    /** Which frame of the sweep this is: 0 is the first image, the left of the desk. */
    poseIndex: z.number().int().nonnegative(),
    label: ClutterLabel,
    /** How much of the clutter this one place is, 0 to 1: the worst places come first. */
    severity: z.number().min(0).max(1),
    /** The place in that frame: x and y from 0 to 1, with (0, 0) at its top-left. */
    at: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  })
  .strict()
export type ClutterHotspot = z.infer<typeof ClutterHotspot>

/**
 * What one sweep of the desk read, judged on the surface alone.
 *
 * `because` is for the console, exactly like `Assessment.because` — it is never
 * spoken, and the policy's templates are what the desk hears.
 */
export const ClutterReading = z
  .object({
    /** How cluttered the desk is, 0 to 1: 0 is a clear surface with room to work. */
    score: z.number().min(0).max(1),
    hotspots: z.array(ClutterHotspot).max(3),
    /** Short facts it actually saw, for the console. */
    evidence: z.array(z.string().max(140)).max(5),
    confidence: z.number().min(0).max(1),
    /** One tutor-facing line, NEVER spoken. */
    because: z.string().max(200),
  })
  .strict()
export type ClutterReading = z.infer<typeof ClutterReading>
