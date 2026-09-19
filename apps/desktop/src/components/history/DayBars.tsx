import type { Day } from '../../lib/analytics'
import { mins } from '../session/format'

/** Focused over off-task, per day. Bars are minutes; an empty day keeps its slot. */
export function DayBars({ days }: { days: Day[] }) {
  const max = Math.max(30, ...days.map((d) => d.focused + d.off))
  return (
    <div className="flex h-44 items-end gap-3">
      {days.map((d, i) => {
        const total = d.focused + d.off
        const today = i === days.length - 1
        return (
          <div key={d.key} className="flex h-full flex-1 flex-col items-center gap-2">
            <span className="tnum text-caption text-text-faint">
              {total ? mins(d.focused) : ''}
            </span>
            <div
              className="flex w-full max-w-[44px] flex-1 flex-col justify-end"
              title={`${d.date.toLocaleDateString('en-GB', { weekday: 'long' })}: ${mins(d.focused)} min focused, ${mins(d.off)} off task, ${d.sessions} sessions`}
            >
              {total ? (
                <div
                  className="flex flex-col overflow-hidden rounded-xs"
                  style={{ height: `${(total / max) * 100}%` }}
                >
                  <span
                    className="w-full bg-warn/80"
                    style={{ height: `${(d.off / total) * 100}%` }}
                  />
                  <span className="w-full flex-1 bg-accent" />
                </div>
              ) : (
                <div className="h-1 rounded-pill bg-border" />
              )}
            </div>
            <span className={`text-caption ${today ? 'font-medium text-text' : 'text-text-faint'}`}>
              {today ? 'Today' : d.date.toLocaleDateString('en-GB', { weekday: 'short' })}
            </span>
          </div>
        )
      })}
    </div>
  )
}
