import { cn } from '@heli/ui'
import type { Day } from '../../lib/analytics'
import { mm } from '../session/format'

const H = 168

/**
 * Minutes per day, focused under off-task, on a real axis with gridlines and the daily average —
 * the Screen Time chart, because people already know how to read it.
 */
export function WeekChart({ days }: { days: Day[] }) {
  const totals = days.map((d) => d.focused + d.off)
  const peak = Math.max(30, ...totals)
  const step = peak > 150 ? 60 : 30
  const top = Math.ceil(peak / step) * step
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step)
  const active = days.filter((d) => d.sessions > 0)
  const avg = active.length ? active.reduce((s, d) => s + d.focused + d.off, 0) / active.length : 0
  const y = (m: number) => (m / top) * H
  const avgY = avg > 0 ? y(avg) : null
  /**
   * The average rule lands wherever the week averages to, which is regularly
   * within a text line of a tick — 53 minutes sits 7 px under the `1h` gridline.
   * Both labels live in the same 8-wide column at the right, so they printed on
   * top of each other.
   *
   * The crowded tick keeps its gridline and loses its label: the line still
   * measures the axis, while the average is the one number in that band with
   * something to say. Only the nearest tick can be inside the 16 px band.
   */
  const labelled = ticks.filter((t) => avgY === null || Math.abs(y(t) - avgY) >= 16)

  return (
    <div className="flex flex-col gap-2">
      <div className="relative" style={{ height: H }}>
        {ticks.map((t) => (
          <div
            key={t}
            className="absolute inset-x-0 flex items-center gap-2"
            style={{ bottom: y(t) }}
          >
            <div className="h-px flex-1 bg-border" />
            <span className="tnum w-8 translate-y-0 text-right text-caption text-text-faint">
              {t === 0 || !labelled.includes(t) ? '' : t % 60 === 0 ? `${t / 60}h` : `${t}m`}
            </span>
          </div>
        ))}
        {avg > 0 ? (
          <div className="absolute inset-x-0 flex items-center gap-2" style={{ bottom: y(avg) }}>
            <div className="flex-1 border-t border-dashed border-ink-400" />
            <span className="w-8 text-right text-caption text-text-muted">avg</span>
          </div>
        ) : null}
        <div className="absolute inset-y-0 left-0 right-10 flex items-end justify-around">
          {days.map((d, i) => (
            <div
              key={d.key}
              className="flex w-7 flex-col-reverse overflow-hidden rounded-t-[4px]"
              style={{ height: y(totals[i]!) }}
              title={`${d.date.toLocaleDateString('en-GB', { weekday: 'long' })} · ${mm(d.focused * 60)} focused, ${mm(d.off * 60)} off task`}
            >
              <span className="w-full bg-accent" style={{ height: y(d.focused) }} />
              <span className="w-full bg-warn" style={{ height: y(d.off) }} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-around pr-10">
        {days.map((d, i) => (
          <span
            key={d.key}
            className={cn(
              'w-7 text-center text-caption',
              i === days.length - 1 ? 'font-semibold text-text' : 'text-text-faint',
            )}
          >
            {d.date.toLocaleDateString('en-GB', { weekday: 'narrow' })}
          </span>
        ))}
      </div>
    </div>
  )
}
