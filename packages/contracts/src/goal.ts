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

/* ---- drafting a goal from a sentence (HELI-072) -------------------------- */

/**
 * What the setup screen sends: one sentence, the person's own words.
 *
 * `.strict()` on purpose. This is the one endpoint whose whole input is a
 * string, so a client that sends `{ text }` or `{ sentence, kind }` is a client
 * that has not read the contract, and the 400 with the issue path is a better
 * answer than a goal drafted from `undefined`. 500 characters is the ceiling the
 * desktop's own field enforces.
 *
 * `.trim()` comes **before** `min(1)`, so a sentence of spaces is not a sentence
 * — it is a 400 that asks the person to type something. Without the trim, "   "
 * is a well-formed request as far as the schema is concerned, the drafter answers
 * with a goal called "Untitled goal", and the setup screen shows a silent
 * failure instead of a field to fill in. The trim runs first, so what reaches the
 * service (and the model) is the sentence without its surrounding whitespace,
 * never the raw padding.
 */
export const GoalDraftRequest = z
  .object({
    sentence: z.string().trim().min(1).max(500),
  })
  .strict()
export type GoalDraftRequest = z.infer<typeof GoalDraftRequest>

/**
 * The suggestion: what `POST /v1/goals/draft` answers with.
 *
 * The shape is deliberately `GoalCreateRequest`'s minus its optional `policy`,
 * **plus** `source`:
 *
 *   - every goal field is here, with no default and no gap, so the draft posts
 *     to `POST /v1/goals` unchanged — `GoalCreateRequest` accepts exactly these
 *     keys and nothing else is added to them;
 *   - `source` is a sibling of the goal fields rather than a field beside the
 *     draft in an envelope, because the response *is* the draft: one object, one
 *     schema in the emitted JSON Schema, and the desktop asserts on
 *     `draft.source` in the same breath as the fields it describes. It is the
 *     only key here that `POST /v1/goals` does not accept, so a client posts the
 *     draft without it (`GoalCreateRequest.parse(draft)` strips it);
 *   - `automations` and `active` are carried for the round trip rather than
 *     suggested: the drafting step never proposes a machine action, so both are
 *     `[]` / `true` from either path.
 *
 * `kind` is part of the draft for the same reason: `GoalCreateRequest` requires
 * it, and a draft that could not be posted would not be a draft.
 */
export const GoalDraft = z.object({
  kind: GoalKind,
  /**
   * The same rule as the request: trimmed, then `min(1)`. The local path always
   * produces a real objective, but the model path is the model's answer, and a
   * draft whose objective is three spaces is the silent failure this contract
   * exists to refuse — it passes `min(1)` untrimmed. Trimmed first, so a padded
   * objective is corrected rather than thrown away.
   */
  objective: z.string().trim().min(1).max(280),
  successCriteria: z.string().max(280).nullable(),
  timeBudgetMinutes: z.number().int().positive().nullable(),
  breakPolicy: BreakPolicy,
  allowedApps: z.array(z.string()),
  blockedApps: z.array(z.string()),
  allowedSites: z.array(z.string()),
  blockedSites: z.array(z.string()),
  permissions: z.array(Permission),
  automations: z.array(Automation),
  active: z.boolean(),
  /** Which path produced this draft: the model, or the local rules. */
  source: z.enum(['model', 'local']),
})
export type GoalDraft = z.infer<typeof GoalDraft>

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
