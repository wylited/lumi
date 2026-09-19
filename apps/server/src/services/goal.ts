import { Automation, BreakPolicy, DEFAULT_POLICY, Goal, GoalKind, Permission, Policy } from '@heli/contracts'
import type { Goal as ApiGoal, GoalCreateRequest, GoalUpdateRequest } from '@heli/contracts'
import type { Goal as GoalRow, Prisma } from '@prisma/client'
import { z } from 'zod'

import { prisma } from '../lib/prisma.js'
import { childLogger } from '../logger.js'

const log = childLogger({ module: 'goal' })

/**
 * Goals: the user's own words in `objective`, the six lists that say what the
 * desk may do, and the `Policy` the loop obeys.
 *
 * The whole file orbits one fact: **the `Goal` table is looser than the contract
 * it has to answer with.** In `prisma/schema.prisma` `kind` and `breakPolicy` are
 * `String`, the four app/site lists plus `permissions`, `automations` and
 * `policy` are untyped `Json`, and `successCriteria`/`timeBudgetMinutes` are
 * nullable. A row with `kind: 'Study'` or a `permissions` column holding
 * `["sneak"]` is a row the database is happy to store and the response
 * serializer will refuse — which is a 500 on `GET /v1/goals`, i.e. the desktop
 * silently falling back to demo data because one goal is spelled oddly.
 *
 * So there is exactly **one** `toApiGoal`, it coerces every field into something
 * the contract definitely accepts before handing it to zod, and every read and
 * write in this file goes through it. Nothing else in the server may read a
 * `Goal` row directly: two mappers would drift, and the one that drifted would
 * be the one feeding the desktop.
 */

/* ---- row to contract ----------------------------------------------------- */

/** `Json` columns are unknown data, not `string[]`. A string is not a list. */
const StringList = z.array(z.string())

const readList = (value: unknown): string[] => {
  const parsed = StringList.safeParse(value)
  return parsed.success ? parsed.data : []
}

/**
 * A list column filtered down to the members the contract's enum actually has.
 * One bad entry drops that entry, not the goal: a goal that lists a permission
 * we removed in a later version still describes a real intention, and refusing
 * it wholesale would take the whole goals screen down with it.
 */
function enumList<T extends string>(schema: z.ZodType<T>, values: string[], field: string): T[] {
  const kept: T[] = []
  for (const value of values) {
    const parsed = schema.safeParse(value)
    if (parsed.success) kept.push(parsed.data)
    else log.warn({ field, value }, 'a goal list holds a value the contract has no member for')
  }
  return kept
}

/**
 * The fallback for an unreadable `kind`.
 *
 * `GoalKind` has three members and the column has none, so a row from outside
 * this server ("Study", "study ", "") has to become one of them or the goal
 * cannot be serialised at all. `study` is the product's own opening example
 * (`docs/00-architecture.md`, and the seed's goal) and the least surprising of
 * the three; the substitution is logged at `warn` so a wrong kind is visible
 * rather than silently corrected.
 */
const readKind = (value: string): GoalKind => {
  const parsed = GoalKind.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn({ kind: value }, 'goal kind is not study/work/life; reporting study')
  return 'study'
}

/** Same reasoning as `readKind`, with `none` — the column's own default. */
const readBreakPolicy = (value: string): BreakPolicy => {
  const parsed = BreakPolicy.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn({ breakPolicy: value }, 'goal break policy is not one of the four; reporting none')
  return 'none'
}

/** The contract caps both free-text fields at 280 characters. The column does not. */
const MAX_TEXT_CHARS = 280

/**
 * `objective` is what the person wrote, so it is never rewritten — only a row
 * too long for the contract (the column has no length limit) is cut, and a row
 * with nothing in it is replaced, because `min(1)` is not negotiable and a 500
 * on the whole list is a worse answer than a visibly placeholder goal.
 */
function readObjective(row: GoalRow): string {
  const value = row.objective
  if (value.length > 0 && value.length <= MAX_TEXT_CHARS) return value
  if (value.length === 0) {
    log.error({ goalId: row.id }, 'goal has no objective; reporting a placeholder one')
    return 'Untitled goal'
  }
  log.warn(
    { goalId: row.id, length: value.length },
    `goal objective is over ${MAX_TEXT_CHARS} characters; truncating`,
  )
  return value.slice(0, MAX_TEXT_CHARS)
}

function readOptionalText(value: string | null, goalId: string, field: string): string | null {
  if (value === null) return null
  if (value.length <= MAX_TEXT_CHARS) return value
  log.warn({ goalId, field, length: value.length }, `goal ${field} is over ${MAX_TEXT_CHARS}; truncating`)
  return value.slice(0, MAX_TEXT_CHARS)
}

/** The contract wants a positive integer or nothing; the column wants an Int. */
const readTimeBudget = (value: number | null): number | null => {
  if (value === null) return null
  if (Number.isInteger(value) && value > 0) return value
  log.warn({ value }, 'goal time budget is not a positive whole number of minutes; reporting none')
  return null
}

/**
 * The policy, parsed through the contract rather than hand-read: every field of
 * `Policy` has a default, so `{}` becomes a complete policy and a column written
 * before a field existed still yields a usable one. `DEFAULT_POLICY` is the
 * answer only for a column that is not an object at all.
 */
const readPolicy = (value: unknown): Policy => {
  const parsed = Policy.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn(
    { issues: parsed.error.issues },
    'goal policy is not readable as a Policy; falling back to DEFAULT_POLICY',
  )
  return DEFAULT_POLICY
}

/**
 * A `Goal` row as the contract's `Goal`. Total: every field is coerced above, so
 * this cannot fail on a row this database is able to hold — and if it somehow
 * does (a value that passes coercion and still is not
 * contract-valid), the goal is reported in its emptiest legal form, with the
 * issue logged at `error`, rather than taking the response down with it.
 */
export function toApiGoal(row: GoalRow): ApiGoal {
  const candidate: ApiGoal = {
    id: row.id,
    kind: readKind(row.kind),
    objective: readObjective(row),
    successCriteria: readOptionalText(row.successCriteria, row.id, 'successCriteria'),
    timeBudgetMinutes: readTimeBudget(row.timeBudgetMinutes),
    breakPolicy: readBreakPolicy(row.breakPolicy),
    allowedApps: readList(row.allowedApps),
    blockedApps: readList(row.blockedApps),
    allowedSites: readList(row.allowedSites),
    blockedSites: readList(row.blockedSites),
    permissions: enumList<Permission>(Permission, readList(row.permissions), 'permissions'),
    automations: enumList<Automation>(Automation, readList(row.automations), 'automations'),
    policy: readPolicy(row.policy),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  }

  const parsed = Goal.safeParse(candidate)
  if (parsed.success) return parsed.data

  log.error(
    { goalId: row.id, issues: parsed.error.issues },
    'a goal row could not be expressed in the contract; reporting the bare minimum',
  )
  return Goal.parse({
    id: row.id,
    kind: 'study',
    objective: 'Untitled goal',
    successCriteria: null,
    timeBudgetMinutes: null,
    breakPolicy: 'none',
    allowedApps: [],
    blockedApps: [],
    allowedSites: [],
    blockedSites: [],
    permissions: ['nudge', 'speak'],
    automations: [],
    policy: DEFAULT_POLICY,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  })
}

/* ---- failures ------------------------------------------------------------ */

/**
 * Fails a request the way `plugins/errors.ts` documents: an Error carrying a
 * `statusCode`, which the error handler turns into `{ error: message }`. A 4xx
 * message is passed through to the client verbatim.
 */
const httpError = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode })

/* ---- writes -------------------------------------------------------------- */

/**
 * The columns a `Goal` is made of, from the contract's own shape.
 *
 * Shared by create and update so a field cannot be writable on one path and
 * forgotten on the other — which is exactly how `PUT` comes to lose a field that
 * `POST` accepted. `policy` is the one field the contract makes optional on
 * create (`GoalCreateRequest`), and `DEFAULT_POLICY` is what a goal with no
 * policy of its own gets: the phase doc names that constant for this case, and a
 * goal whose policy is missing must still obey *some* policy rather than
 * disabling the loop.
 */
function columnsOf(goal: GoalCreateRequest): Prisma.GoalUncheckedCreateInput {
  return {
    kind: goal.kind,
    objective: goal.objective,
    successCriteria: goal.successCriteria,
    timeBudgetMinutes: goal.timeBudgetMinutes,
    breakPolicy: goal.breakPolicy,
    allowedApps: goal.allowedApps,
    blockedApps: goal.blockedApps,
    allowedSites: goal.allowedSites,
    blockedSites: goal.blockedSites,
    permissions: goal.permissions,
    automations: goal.automations,
    policy: goal.policy ?? DEFAULT_POLICY,
    active: goal.active,
  }
}

/** Every goal, active first. The desktop and the web both render this list as it comes. */
export async function listGoals(): Promise<ApiGoal[]> {
  const rows = await prisma.goal.findMany({
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map(toApiGoal)
}

export async function createGoal(input: GoalCreateRequest): Promise<ApiGoal> {
  const row = await prisma.goal.create({ data: columnsOf(input) })
  log.info({ goalId: row.id, kind: row.kind }, 'goal created')
  return toApiGoal(row)
}

/**
 * `PUT` is a **merge**: every field the request names replaces the stored one,
 * everything else is left alone. That is what the two clients mean by it —
 * `apps/desktop/src/lib/api.ts#updateGoal` sends a single-field patch and
 * `apps/web`'s `write()` an arbitrary one, and a true replace-semantics `PUT`
 * would silently blank every field the patch did not mention.
 *
 * `undefined` and `null` are deliberately different here. `successCriteria` and
 * `timeBudgetMinutes` are nullable in the contract, so `null` means "clear this"
 * while an absent key means "leave it" — which is why those two compare against
 * `undefined` instead of using `??`.
 */
export async function updateGoal(id: string, patch: GoalUpdateRequest): Promise<ApiGoal> {
  const row = await prisma.goal.findUnique({ where: { id } })
  if (row === null) throw httpError(404, `No goal ${id}.`)

  const current = toApiGoal(row)
  const next: GoalCreateRequest = {
    kind: patch.kind ?? current.kind,
    objective: patch.objective ?? current.objective,
    successCriteria:
      patch.successCriteria === undefined ? current.successCriteria : patch.successCriteria,
    timeBudgetMinutes:
      patch.timeBudgetMinutes === undefined ? current.timeBudgetMinutes : patch.timeBudgetMinutes,
    breakPolicy: patch.breakPolicy ?? current.breakPolicy,
    allowedApps: patch.allowedApps ?? current.allowedApps,
    blockedApps: patch.blockedApps ?? current.blockedApps,
    allowedSites: patch.allowedSites ?? current.allowedSites,
    blockedSites: patch.blockedSites ?? current.blockedSites,
    permissions: patch.permissions ?? current.permissions,
    automations: patch.automations ?? current.automations,
    policy: patch.policy ?? current.policy,
    active: patch.active ?? current.active,
  }

  const updated = await prisma.goal.update({ where: { id }, data: columnsOf(next) })
  log.info({ goalId: updated.id }, 'goal updated')
  return toApiGoal(updated)
}

/**
 * `DELETE /v1/goals/:id`, and the one refusal this row's acceptance test names.
 *
 * `Session.goalId` is a required foreign key with no `onDelete`, so deleting a
 * goal a session points at is a `P2003` — a 500 with `Internal server error` in
 * it, which tells the caller nothing and looks like a bug in the server. So the
 * sessions are counted first and a goal that has any is refused with a 409 that
 * names the reason and the number.
 *
 * The count is not advisory. A closed session's observations are the *only*
 * record of what happened in it (`docs/01-contracts.md` §1: every screen is a
 * query over `observation`), so a cascade here would delete the history the
 * dashboard exists to show.
 *
 * Devices that point at the goal are not counted: `Device.goalId` is optional
 * and `SetNull`, so they simply stop naming a goal, which is the correct
 * outcome for a device whose goal was deleted.
 *
 * On success the deleted goal is echoed back — §7 lists `Goal` as what
 * `POST`/`GET`/`PUT`/`DELETE` on `/goals` return, and a client that kept the
 * row it just deleted has something honest to undo with.
 */
export async function deleteGoal(id: string): Promise<ApiGoal> {
  const row = await prisma.goal.findUnique({ where: { id } })
  if (row === null) throw httpError(404, `No goal ${id}.`)

  const sessions = await prisma.session.count({ where: { goalId: id } })
  if (sessions > 0) {
    // Written out rather than interpolated from a plural helper: it is one
    // sentence a person actually reads, and "1 session still reference it" is
    // the kind of thing that makes a refusal look like a bug.
    const noun = sessions === 1 ? 'session' : 'sessions'
    const verb = sessions === 1 ? 'references' : 'reference'
    throw httpError(
      409,
      `Goal ${id} cannot be deleted: ${sessions} ${noun} still ${verb} it, and a session's observations are the record of what happened in it.`,
    )
  }

  const deleted = await prisma.goal.delete({ where: { id } })
  log.info({ goalId: id }, 'goal deleted')
  return toApiGoal(deleted)
}
