import type { Prisma } from '@prisma/client'

import { Outcome, Tier } from '@heli/contracts'
import type {
  AnalyticsAppRow,
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTierRow,
  AnalyticsTiersResponse,
  Observation as ApiObservation,
} from '@heli/contracts'

import { prisma } from '../lib/prisma.js'
import { toApiObservations } from '../lib/rows.js'
import { childLogger } from '../logger.js'

const log = childLogger({ module: 'analytics' })

/**
 * The four analytics reads.
 *
 * Every number here is aggregated from real rows — `Observation` for the focus
 * maths, `Intervention` for anything about what fired. There is nothing cached,
 * nothing precomputed and no constant that stands in for a measurement: the
 * seeded session shows up in these answers because it is in the tables, and an
 * empty database answers with zeroes and empty arrays rather than with a
 * plausible-looking demo.
 *
 * The contract shapes are the ones the web and the desktop parse with
 * `@heli/contracts`, and the routes declare them as their `response` schema, so
 * a shape that drifts here turns a 200 into a 500 rather than into a silently
 * wrong dashboard. Where a row cannot be expressed in a contract shape (a tier
 * outside 0-5, an outcome that is not one of the four) this module degrades the
 * row and logs it instead of passing the mistake downstream.
 */

/**
 * Half-open on neither side: `from` and `to` are inclusive bounds, and either
 * may be absent.
 *
 * Both bounds absent means *all time*, which is the case that matters. Neither
 * client sends a query string at all — `apps/web/lib/api.ts` and
 * `apps/desktop/src/lib/api.ts` call `/analytics/summary` bare — and a non-2xx
 * reads as empty, so a route that demanded a window would leave the dashboard
 * quietly empty.
 */
export interface AnalyticsWindow {
  from?: Date
  to?: Date
}

/** Inclusive bounds, or nothing at all when the caller asked for all time. */
function tsBounds(window: AnalyticsWindow): Prisma.DateTimeFilter | undefined {
  const bounds: Prisma.DateTimeFilter = {}
  if (window.from) bounds.gte = window.from
  if (window.to) bounds.lte = window.to
  return Object.keys(bounds).length > 0 ? bounds : undefined
}

/**
 * Which observations are in scope: by `ts`, the moment the window was assessed.
 *
 * An inverted window (`from` after `to`) is empty rather than an error, by the
 * same rule as a window that simply contains no observations.
 */
function observationWhere(window: AnalyticsWindow): Prisma.ObservationWhereInput {
  const ts = tsBounds(window)
  return ts ? { ts } : {}
}

/**
 * Interventions are windowed by *their own* `firedAt`, not by the `ts` of the
 * observation they came from. An intervention that fires at 15:00 off a window
 * assessed at 14:59 belongs to the hour it actually interrupted.
 */
function interventionWhere(window: AnalyticsWindow): Prisma.InterventionWhereInput {
  const firedAt = tsBounds(window)
  return firedAt ? { firedAt } : {}
}

/**
 * The rows behind every aggregate, mapped through `rows.ts` so the `signals`
 * Json column becomes a parsed `SignalWindow` once, here, rather than a second
 * hand-rolled parse per endpoint.
 *
 * `toApiObservations` drops rows whose `signals` or `tier` is unreadable and
 * logs them; that is deliberate and it is the right call for these reads too —
 * a fabricated zeroed window would put invented focus minutes into the numbers
 * the dashboard exists to show.
 */
async function loadObservations(window: AnalyticsWindow): Promise<ApiObservation[]> {
  const rows = await prisma.observation.findMany({
    where: observationWhere(window),
    orderBy: [{ sessionId: 'asc' }, { ts: 'asc' }],
  })
  return toApiObservations(rows)
}

/** Two decimals: a dashboard wants a figure, not a float. */
function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * The desktop's `derive()` — the live view of the same session — treats a
 * window as focus when the model judged it on task *and* it was not a break,
 * and measures the run in the window's own `focusedSeconds`. Both rules are
 * repeated here on purpose: if the live tray and the heatmap disagreed about
 * whether a run broke, one of the two would be lying about the same minute.
 *
 * An observation with no `assessment` (the model was unreachable) cannot be a
 * focus window, so it breaks a run.
 */
function countsAsFocus(observation: ApiObservation): boolean {
  const assessment = observation.assessment
  if (!assessment || !assessment.onTask) return false
  return assessment.activity !== 'break'
}

/**
 * The longest unbroken stretch of focus, in seconds, across every session in
 * scope.
 *
 * Runs are computed per session and then compared. Concatenating sessions would
 * be cheaper and wrong: the gap between closing the laptop on Friday and opening
 * it on Monday would read as one very long run of focus.
 */
function longestRunSeconds(observations: ApiObservation[]): number {
  const bySession = new Map<string, ApiObservation[]>()
  for (const observation of observations) {
    const group = bySession.get(observation.sessionId)
    if (group) group.push(observation)
    else bySession.set(observation.sessionId, [observation])
  }

  let longest = 0
  for (const sessionRows of bySession.values()) {
    sessionRows.sort((a, b) => a.ts.localeCompare(b.ts))
    let run = 0
    for (const observation of sessionRows) {
      if (countsAsFocus(observation)) {
        run += observation.signals.focusedSeconds
        longest = Math.max(longest, run)
      } else {
        run = 0
      }
    }
  }
  return longest
}

/**
 * `focusedMinutes`, `offTaskMinutes`, `interventions`, `longestFocusRunSeconds`
 * and the tier histogram.
 *
 * The minutes are the sum of each window's own `focusedSeconds` /
 * `offTaskSeconds` — the seconds the desktop measured, not a count of windows
 * multiplied by a nominal window length. A window is a minute of wall clock
 * today, but the seed and the policy both treat `windowMs` as data, and a
 * count-based minute would keep claiming 60 s per window after the first commit
 * that changes it. They are reported to one decimal, as the session summary is.
 *
 * The histogram is counted over the same rows the minutes come from, so its
 * total always equals the number of observations those minutes describe. Keys
 * are tier numbers as strings, which is what `z.record` in the contract means.
 */
export async function analyticsSummary(window: AnalyticsWindow = {}): Promise<AnalyticsSummary> {
  const [observations, interventions] = await Promise.all([
    loadObservations(window),
    prisma.intervention.count({ where: interventionWhere(window) }),
  ])

  let focusedSeconds = 0
  let offTaskSeconds = 0
  const tierHistogram: Record<string, number> = {}

  for (const observation of observations) {
    focusedSeconds += observation.signals.focusedSeconds
    offTaskSeconds += observation.signals.offTaskSeconds
    const tier = String(observation.tier)
    tierHistogram[tier] = (tierHistogram[tier] ?? 0) + 1
  }

  return {
    focusedMinutes: round(focusedSeconds / 60, 1),
    offTaskMinutes: round(offTaskSeconds / 60, 1),
    interventions,
    longestFocusRunSeconds: longestRunSeconds(observations),
    tierHistogram,
  }
}

/**
 * An outcome the contract can carry.
 *
 * `Outcome` has no null and no other member, and the response serializer will
 * not send what the enum does not have. A null outcome means the intervention
 * fired and nothing ever judged it, which is exactly what the contract's
 * `unknown` says — and it is how the web reads it: `components/analytics/
 * derive.ts` keeps `unknown` out of the rate denominator, "an unjudged
 * intervention is never a win", and prints it as "unjudged".
 *
 * So a null becomes `unknown` silently — an unjudged intervention is an
 * ordinary state, not a mistake — and a string none of the four matches becomes
 * `unknown` with a warning. The alternative, dropping the row, would make a
 * fired intervention vanish from a table whose whole job is counting what fired.
 */
function knownOutcome(value: string | null): Outcome {
  if (value === null) return 'unknown'
  const parsed = Outcome.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn({ outcome: value }, 'intervention outcome is not one of the four; reporting unknown')
  return 'unknown'
}

/**
 * `GROUP BY tier, outcome` over `Intervention` — what actually gets the person
 * back on task.
 *
 * The grouping is done by Postgres, not by folding rows in Node, so the answer
 * is the same aggregate a person gets by typing the query.
 */
export async function analyticsTiers(window: AnalyticsWindow = {}): Promise<AnalyticsTiersResponse> {
  const grouped = await prisma.intervention.groupBy({
    by: ['tier', 'outcome'],
    where: interventionWhere(window),
    _count: { _all: true },
  })

  const rows: AnalyticsTierRow[] = []
  for (const group of grouped) {
    const tier = Tier.safeParse(group.tier)
    if (!tier.success) {
      // The contract's `Tier` is 0-5 and the column is a plain Int. A row
      // outside the range cannot be serialised, and inventing a value for it
      // would put a fiction in the table, so it is reported and skipped.
      log.error({ tier: group.tier, count: group._count._all }, 'intervention tier is outside 0-5')
      continue
    }
    rows.push({
      tier: tier.data,
      outcome: knownOutcome(group.outcome),
      count: group._count._all,
    })
  }

  return rows.sort((a, b) => a.tier - b.tier || a.outcome.localeCompare(b.outcome))
}

/**
 * Time per app, ranked by seconds descending.
 *
 * Only `signals.topApps` is read: an app is an app, and a site is already
 * carried by `topSites`.
 *
 * Rows are keyed by app *and* on-task, because the same application is both: the
 * seed's Safari is on-task on a problem set and off-task on YouTube, and merging
 * the two would report the browser as one number that means nothing. The web
 * filters on that flag to build the distractions list.
 */
export async function analyticsApps(window: AnalyticsWindow = {}): Promise<AnalyticsAppsResponse> {
  const rows = await loadObservations(window)

  const byApp = new Map<string, AnalyticsAppRow>()
  for (const observation of rows) {
    for (const entry of observation.signals.topApps) {
      const key = `${entry.onTask ? 'on' : 'off'}:${entry.app}`
      const row = byApp.get(key) ?? { app: entry.app, seconds: 0, onTask: entry.onTask }
      row.seconds += entry.seconds
      byApp.set(key, row)
    }
  }

  return [...byApp.values()].sort(
    (a, b) => b.seconds - a.seconds || a.app.localeCompare(b.app) || Number(a.onTask) - Number(b.onTask),
  )
}

/**
 * Focus by hour of day.
 *
 * **Bucketed by the server process's local timezone** (`Date#getHours`), not by
 * UTC. A heatmap answers "when in my day am I sharpest", so the bucket has to be
 * the hour on the wall clock the person was sitting at. The deployment is one
 * person, one desk, one box (AGENTS.md: single-user), and the desktop's
 * `derive()` sums a live snapshot in local time. Bucketing in UTC here would
 * move an evening session to the early hours of the next day.
 *
 * The gap this leaves: a server running in a different timezone from the person
 * reports *its* hours. `@heli/contracts` has no user timezone to fix that with,
 * and adding one is a contracts commit, not this one.
 *
 * Each cell is the mean of the windows' own `onTaskRatio` — a seconds-based
 * measure of how much of that window was on task — rather than the fraction of
 * windows judged on task, which would weigh a one-second glance like a full
 * minute of work. Windows assessed as a `break` are left out: a break is not focus, and counting one as a low ratio would drag an
 * hour down for an action the person was told to take.
 *
 * **An hour with no observations is absent from the array, not zero.** The web's
 * `components/analytics/Heatmap.tsx` draws a dashed outline for a missing hour
 * and says why in its own words: "not working is not the same as not focusing".
 * A zero has to keep meaning "present, and completely off task".
 */
export async function analyticsHeatmap(
  window: AnalyticsWindow = {},
): Promise<AnalyticsHeatmapResponse> {
  const rows = await loadObservations(window)

  const buckets = new Map<number, { sum: number; windows: number }>()
  for (const observation of rows) {
    if (observation.assessment?.activity === 'break') continue
    const hour = new Date(observation.ts).getHours()
    const bucket = buckets.get(hour) ?? { sum: 0, windows: 0 }
    bucket.sum += observation.signals.onTaskRatio
    bucket.windows += 1
    buckets.set(hour, bucket)
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, bucket]) => ({
      hour,
      // Every `onTaskRatio` is validated into 0-1 by `rows.ts`, so a mean of them
      // is inside 0-1 and rounding to two decimals cannot leave the range.
      onTaskRatio: round(bucket.sum / bucket.windows, 2),
    }))
}
