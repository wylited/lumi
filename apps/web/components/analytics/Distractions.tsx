import type { AnalyticsAppRow } from '@heli/contracts'
import { EmptyState } from '@heli/ui'
import { duration } from '@/lib/format'

export function Distractions({ rows, limit = 6 }: { rows: AnalyticsAppRow[]; limit?: number }) {
  const off = rows.filter((r) => !r.onTask).slice(0, limit)
  if (off.length === 0) return <EmptyState title="Nothing pulled you away. That is the result." />
  const max = off[0]?.seconds ?? 1
  return (
    <ol className="flex flex-col gap-3.5">
      {off.map((r, i) => (
        <li key={r.app} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-2.5">
              <span className="tnum w-4 shrink-0 font-mono text-[11px] text-text-faint">
                {i + 1}
              </span>
              <span className="truncate text-small text-text">{r.app}</span>
            </span>
            <span className="tnum shrink-0 text-small text-text-muted">{duration(r.seconds)}</span>
          </div>
          <div className="ml-[26px] h-1 rounded-pill bg-surface">
            <div
              className="h-full rounded-pill bg-warn"
              style={{ width: `${(r.seconds / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  )
}
