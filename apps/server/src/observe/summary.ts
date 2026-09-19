import type { SessionSummary } from '@heli/contracts'

export interface SummaryInput {
  goal: { objective: string; timeBudgetMinutes: number | null }
  session: { startedAt: number; endedAt: number }
  observations: {
    ts: number
    tier: number
    outcome: string | null
    reason: string | null
    confidence: number | null
    window: {
      focusedSeconds: number
      offTaskSeconds: number
      contextSwitches: number
      longestFocusRunSeconds: number
      topApps: { app: string; seconds: number; onTask: boolean }[]
    }
    assessment: { kind: string | null; activity: string } | null
  }[]
}

type Observation = SummaryInput['observations'][number]

const round1 = (value: number): number => Math.round(value * 10) / 10

const TIER_NAMES: Record<number, string> = {
  1: 'ambient signal',
  2: 'nudge',
  3: 'spoken line',
  4: 'automatic action',
  5: 'summary',
}

const tierName = (tier: number): string => TIER_NAMES[tier] ?? `tier ${tier}`

const formatMinutes = (minutes: number): string => {
  const rounded = round1(minutes)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

const leaderOf = (totals: Map<string, number>): string | null => {
  let name: string | null = null
  let seconds = 0
  for (const [candidate, value] of totals) {
    if (value > seconds) {
      name = candidate
      seconds = value
    }
  }
  return name
}

const topDistractionOf = (observations: Observation[]): string | null => {
  const appSeconds = new Map<string, number>()
  for (const observation of observations) {
    for (const app of observation.window.topApps) {
      if (app.onTask || app.seconds <= 0 || app.app.length === 0) continue
      appSeconds.set(app.app, (appSeconds.get(app.app) ?? 0) + app.seconds)
    }
  }
  if (appSeconds.size > 0) return leaderOf(appSeconds)

  const kindSeconds = new Map<string, number>()
  for (const observation of observations) {
    const kind = observation.assessment?.kind
    if (!kind || observation.window.offTaskSeconds <= 0) continue
    kindSeconds.set(kind, (kindSeconds.get(kind) ?? 0) + observation.window.offTaskSeconds)
  }
  return kindSeconds.size > 0 ? leaderOf(kindSeconds) : null
}

const headlineFor = (
  input: SummaryInput,
  totals: { focusedMinutes: number; offTaskMinutes: number; interventions: number },
  worked: SessionSummary['worked'],
  topDistraction: string | null,
): string => {
  const objective = input.goal.objective.trim()
  if (input.observations.length === 0) {
    return `No observations were recorded for ${objective}.`
  }

  const focused = formatMinutes(totals.focusedMinutes)
  const offTask = formatMinutes(totals.offTaskMinutes)
  const budget = input.goal.timeBudgetMinutes
  const budgetClause =
    budget !== null && budget > 0
      ? `, ${Math.round((totals.focusedMinutes / budget) * 100)}% of the ${budget} minute budget`
      : ''

  if (totals.interventions === 0) {
    const lead = totals.offTaskMinutes > totals.focusedMinutes ? `only ${focused}` : focused
    return `${lead} focused minutes and ${offTask} off task on ${objective}${budgetClause}; no interventions fired.`
  }

  const best = worked[0]
  if (best) {
    const drift = topDistraction ? `, with most of the drift on ${topDistraction}` : ''
    return `${focused} focused minutes and ${offTask} off task on ${objective}${budgetClause}; the ${tierName(best.tier)} resolved ${best.count} of ${totals.interventions} interventions${drift}.`
  }

  return `${focused} focused minutes and ${offTask} off task on ${objective}${budgetClause}; ${totals.interventions} interventions fired and none resolved the drift.`
}

export function buildSummary(input: SummaryInput): SessionSummary {
  let focusedSeconds = 0
  let offTaskSeconds = 0
  let longestFocusRunSeconds = 0
  let interventions = 0
  const workedCounts = new Map<number, number>()

  for (const observation of input.observations) {
    focusedSeconds += observation.window.focusedSeconds
    offTaskSeconds += observation.window.offTaskSeconds
    longestFocusRunSeconds = Math.max(
      longestFocusRunSeconds,
      observation.window.longestFocusRunSeconds,
    )
    if (observation.tier > 0) {
      interventions += 1
      if (observation.outcome === 'resolved') {
        workedCounts.set(observation.tier, (workedCounts.get(observation.tier) ?? 0) + 1)
      }
    }
  }

  const focusedMinutes = round1(focusedSeconds / 60)
  const offTaskMinutes = round1(offTaskSeconds / 60)

  const worked: SessionSummary['worked'] = [...workedCounts.entries()]
    .map(([tier, count]) => ({ tier, outcome: 'resolved', count }))
    .sort((a, b) => b.count - a.count || a.tier - b.tier)

  const topDistraction = topDistractionOf(input.observations)
  const totals = { focusedMinutes, offTaskMinutes, interventions }

  return {
    focusedMinutes,
    offTaskMinutes,
    longestFocusRunSeconds,
    topDistraction,
    worked,
    message: headlineFor(input, totals, worked, topDistraction),
  }
}
