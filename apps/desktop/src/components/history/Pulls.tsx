import type { AnalyticsAppRow } from '@heli/contracts'
import { mm } from '../session/format'

export function Pulls({ rows }: { rows: AnalyticsAppRow[] }) {
  const off = rows.filter((r) => !r.onTask).slice(0, 5)
  if (!off.length) return <p className="text-small text-text-faint">Nothing pulled you away.</p>
  const max = off[0]!.seconds
  return (
    <ul className="flex flex-col gap-3.5">
      {off.map((r) => (
        <li key={r.app} className="grid grid-cols-[1fr_120px_44px] items-center gap-3">
          <span className="truncate text-small text-text-muted">{r.app}</span>
          <span className="h-2 overflow-hidden rounded-pill bg-ink-100">
            <span
              className="block h-full rounded-pill bg-warn"
              style={{ width: `${(r.seconds / max) * 100}%` }}
            />
          </span>
          <span className="tnum text-right text-small text-text-muted">{mm(r.seconds)}</span>
        </li>
      ))}
    </ul>
  )
}
