import { TIER_NAMES, type TierLevel } from '@heli/ui'
import { percent } from '@/lib/format'

const TONE = ['bg-ink-300/50', 'bg-accent', 'bg-warn', 'bg-warn', 'bg-danger', 'bg-text-muted']

/** Every assessed window, by the tier it ended at. Most of it should be grey. */
export function SilenceBar({ histogram }: { histogram: Record<string, number> }) {
  const entries = Object.entries(histogram)
    .map(([t, n]) => [Number(t), n] as const)
    .sort((a, b) => a[0] - b[0])
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1
  const silent = (histogram['0'] ?? 0) / total
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-pill">
        {entries.map(([t, n]) => (
          <span
            key={t}
            className={`h-full ${TONE[t]}`}
            style={{ width: `${(n / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-caption text-text-faint">
        <span>
          <span className="tnum text-text">{percent(silent)}</span> of {total} windows ended in
          silence
        </span>
        {entries
          .filter(([t]) => t > 0)
          .map(([t, n]) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <span className={`size-2 rounded-pill ${TONE[t]}`} />
              <span className="tnum">{n}</span> {TIER_NAMES[t as TierLevel]}
            </span>
          ))}
      </div>
    </div>
  )
}
