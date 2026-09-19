import type {
  AnalyticsAppRow,
  AnalyticsHeatmapRow,
  AnalyticsSummary,
  AnalyticsTierRow,
  Outcome,
  SessionDetail,
} from '@heli/contracts'
import { round } from './story.js'

/** The analytics endpoints are `GROUP BY`s over observations; so are these. */

export function summary(sessions: SessionDetail[]): AnalyticsSummary {
  let focused = 0
  let off = 0
  let interventions = 0
  let longest = 0
  const tierHistogram: Record<string, number> = {}
  for (const s of sessions) {
    interventions += s.interventionCount
    longest = Math.max(longest, s.summary?.longestFocusRunSeconds ?? 0)
    for (const o of s.observations) {
      focused += o.signals.focusedSeconds
      off += o.signals.offTaskSeconds
      tierHistogram[String(o.tier)] = (tierHistogram[String(o.tier)] ?? 0) + 1
    }
  }
  return {
    focusedMinutes: round(focused / 60, 1),
    offTaskMinutes: round(off / 60, 1),
    interventions,
    longestFocusRunSeconds: longest,
    tierHistogram,
  }
}

export function tiers(sessions: SessionDetail[]): AnalyticsTierRow[] {
  const rows = new Map<string, AnalyticsTierRow>()
  for (const s of sessions) {
    for (const o of s.observations) {
      if (o.tier === 0 || o.outcome === null) continue
      const key = `${o.tier}:${o.outcome}`
      const row = rows.get(key) ?? { tier: o.tier, outcome: o.outcome as Outcome, count: 0 }
      row.count += 1
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort((a, b) => a.tier - b.tier || a.outcome.localeCompare(b.outcome))
}

export function apps(sessions: SessionDetail[]): AnalyticsAppRow[] {
  const rows = new Map<string, AnalyticsAppRow>()
  for (const s of sessions) {
    for (const o of s.observations) {
      const names = o.signals.topSites.length
        ? o.signals.topSites.map((site) => ({
            app: site.title,
            seconds: site.seconds,
            onTask: site.onTask,
          }))
        : o.signals.topApps
      for (const a of names) {
        const label = o.assessment?.kind === 'phone' && !a.onTask ? 'Phone' : a.app
        const key = `${label}:${a.onTask}`
        const row = rows.get(key) ?? { app: label, seconds: 0, onTask: a.onTask }
        row.seconds += a.seconds
        rows.set(key, row)
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.seconds - a.seconds)
}

export function heatmap(sessions: SessionDetail[]): AnalyticsHeatmapRow[] {
  const buckets = new Map<number, { sum: number; n: number }>()
  for (const s of sessions) {
    for (const o of s.observations) {
      if (o.assessment?.activity === 'break') continue
      const hour = new Date(o.ts).getHours()
      const b = buckets.get(hour) ?? { sum: 0, n: 0 }
      b.sum += o.signals.onTaskRatio
      b.n += 1
      buckets.set(hour, b)
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, b]) => ({ hour, onTaskRatio: round(b.sum / b.n) }))
}
