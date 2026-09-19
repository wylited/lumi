import type { AnalyticsTierRow } from '@heli/contracts'

export interface TierEffect {
  tier: number
  resolved: number
  ignored: number
  reverted: number
  unknown: number
  total: number
  /** resolved / judged, where judged excludes `unknown` — an unjudged intervention is never a win. */
  rate: number | null
}

/** Fewer samples than this and a rate is noise, not a finding. */
export const MIN_SAMPLES = 3

export function tierEffects(rows: AnalyticsTierRow[]): TierEffect[] {
  const byTier = new Map<number, TierEffect>()
  for (const row of rows) {
    if (row.tier === 0) continue
    const e = byTier.get(row.tier) ?? {
      tier: row.tier,
      resolved: 0,
      ignored: 0,
      reverted: 0,
      unknown: 0,
      total: 0,
      rate: null,
    }
    e[row.outcome] += row.count
    e.total += row.count
    byTier.set(row.tier, e)
  }
  return [...byTier.values()]
    .map((e) => {
      const judged = e.total - e.unknown
      return { ...e, rate: judged > 0 ? e.resolved / judged : null }
    })
    .sort((a, b) => a.tier - b.tier)
}

export function mostEffective(effects: TierEffect[]): TierEffect | null {
  const eligible = effects.filter((e) => e.rate !== null && e.total - e.unknown >= MIN_SAMPLES)
  return eligible.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || a.tier - b.tier)[0] ?? null
}
