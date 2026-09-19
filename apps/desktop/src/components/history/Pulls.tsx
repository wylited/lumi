import type { AnalyticsAppRow } from '@heli/contracts'
import { dur } from '../session/format'

export function Pulls({ rows }: { rows: AnalyticsAppRow[] }) {
  const off = rows.filter((r) => !r.onTask).slice(0, 5)
  if (!off.length) return <p className="text-small text-text-faint">Nothing pulled you away.</p>
  const max = off[0]!.seconds
  return (
    <ol className="flex flex-col gap-3">
      {off.map((r) => (
        <li key={r.app} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5">
          <span className="truncate text-small text-text">{r.app}</span>
          <span className="tnum text-small text-text-muted">{dur(r.seconds)}</span>
          <div className="col-span-2 h-1 rounded-pill bg-border-strong/50">
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
