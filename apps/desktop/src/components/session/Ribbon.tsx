import type { Observation } from '@heli/contracts'
import { cn } from '@heli/ui'
import { FILL, stateOf } from './states'

/**
 * The session as a ribbon of minutes. Its width is the time budget, so the empty cells are the
 * time left; each filled cell is one minute, coloured by what the assessment said. A tick above
 * a cell marks a minute where the system interrupted (nudge or voice).
 */
export function Ribbon({
  observations,
  minutes,
  breaks = [],
  size = 'lg',
}: {
  observations: Observation[]
  /** Total cells. Defaults to the observations, i.e. no budget. */
  minutes?: number | null
  /** Minute marks to label under the ribbon, e.g. scheduled breaks. */
  breaks?: number[]
  size?: 'lg' | 'sm'
}) {
  const total = Math.max(minutes ?? 0, observations.length, 1)
  const cells = Array.from({ length: total }, (_, i) => observations[i] ?? null)
  const lg = size === 'lg'

  return (
    <div className="flex w-full flex-col gap-1.5">
      {lg ? (
        <div className="flex h-2.5 gap-[2px]" aria-hidden="true">
          {cells.map((o, i) => (
            <span key={i} className="flex flex-1 justify-center">
              {o && o.tier >= 2 ? (
                <span
                  className={cn('h-full w-[2px] rounded-pill', o.tier >= 3 ? 'bg-text' : 'bg-warn')}
                />
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className={cn('flex w-full', lg ? 'h-7 gap-[2px]' : 'h-2 gap-px')}
        role="img"
        aria-label={summary(observations, total)}
      >
        {cells.map((o, i) => (
          <span
            key={o?.id ?? `empty-${i}`}
            className={cn(
              'flex-1',
              lg ? 'rounded-[3px]' : 'first:rounded-l-[2px] last:rounded-r-[2px]',
              FILL[o ? stateOf(o) : 'empty'],
            )}
            title={o ? `${i + 1}m · ${o.assessment?.because ?? o.reason ?? ''}` : undefined}
          />
        ))}
      </div>
      {lg ? (
        <div className="relative h-4 text-caption text-text-faint">
          <span className="tnum absolute left-0">0</span>
          {breaks
            .filter((b) => b > 0 && b < total)
            .map((b) => (
              <span key={b} className="absolute" style={{ left: `${(b / total) * 100}%` }}>
                Break
              </span>
            ))}
          <span className="tnum absolute right-0">{total} min</span>
        </div>
      ) : null}
    </div>
  )
}

function summary(obs: Observation[], total: number) {
  const on = obs.filter((o) => {
    const s = stateOf(o)
    return s === 'focus' || s === 'glance'
  }).length
  return `${on} of ${obs.length} minutes on the goal, ${total - obs.length} minutes left`
}

export function RibbonLegend() {
  return (
    <div className="flex items-center gap-4 text-caption text-text-faint">
      {(
        [
          ['focus', 'Focused'],
          ['drift', 'Off task'],
          ['break', 'Break'],
        ] as const
      ).map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', FILL[k])} />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-[2px] rounded-pill bg-warn" />
        Nudge
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-[2px] rounded-pill bg-text" />
        Voice
      </span>
    </div>
  )
}
