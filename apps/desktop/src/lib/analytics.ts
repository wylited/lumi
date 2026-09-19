/** History: everything the review screen reads, in one load, plus the derivations it needs. */
import type {
  AnalyticsAppRow,
  AnalyticsHeatmapRow,
  AnalyticsSummary,
  AnalyticsTierRow,
  Session,
} from '@heli/contracts'
import { api } from './api'

export interface History {
  summary: AnalyticsSummary
  tiers: AnalyticsTierRow[]
  apps: AnalyticsAppRow[]
  heatmap: AnalyticsHeatmapRow[]
  sessions: Session[]
}

export async function loadHistory(): Promise<History> {
  const [summary, tiers, apps, heatmap, sessions] = await Promise.all([
    api.analytics.summary(),
    api.analytics.tiers(),
    api.analytics.apps(),
    api.analytics.heatmap(),
    api.sessions(),
  ])
  return { summary, tiers, apps, heatmap, sessions: sessions.filter((s) => s.endedAt) }
}

export interface TierEffect {
  tier: number
  resolved: number
  judged: number
  total: number
  rate: number | null
}

/** Unjudged interventions (`unknown`) are counted but never as wins. */
export function tierEffects(rows: AnalyticsTierRow[]): TierEffect[] {
  const m = new Map<number, TierEffect>()
  for (const r of rows) {
    if (r.tier === 0) continue
    const e = m.get(r.tier) ?? { tier: r.tier, resolved: 0, judged: 0, total: 0, rate: null }
    e.total += r.count
    if (r.outcome !== 'unknown') e.judged += r.count
    if (r.outcome === 'resolved') e.resolved += r.count
    m.set(r.tier, e)
  }
  return [...m.values()]
    .map((e) => ({ ...e, rate: e.judged ? e.resolved / e.judged : null }))
    .sort((a, b) => a.tier - b.tier)
}

export function bestTier(effects: TierEffect[], minSamples = 3): TierEffect | null {
  return (
    effects
      .filter((e) => e.rate !== null && e.judged >= minSamples)
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || a.tier - b.tier)[0] ?? null
  )
}

export interface Day {
  key: string
  date: Date
  focused: number
  off: number
  sessions: number
}

/** The last `n` days, oldest first, including days with nothing — an empty day is data too. */
export function byDay(sessions: Session[], n = 7, now = new Date()): Day[] {
  const days: Day[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    days.push({ key: d.toDateString(), date: d, focused: 0, off: 0, sessions: 0 })
  }
  for (const s of sessions) {
    const day = days.find((d) => d.key === new Date(s.startedAt).toDateString())
    if (!day || !s.summary) continue
    day.focused += s.summary.focusedMinutes
    day.off += s.summary.offTaskMinutes
    day.sessions += 1
  }
  return days
}
