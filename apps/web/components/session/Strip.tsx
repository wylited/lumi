import type { Observation } from '@heli/contracts'
import { cn } from '@heli/ui'
import { clock } from '@/lib/format'

type Kind = 'on' | 'glance' | 'off' | 'break' | 'unknown'

function kindOf(o: Observation): Kind {
  const a = o.assessment
  if (!a) return 'unknown'
  if (a.activity === 'break') return 'break'
  if (!a.onTask) return 'off'
  return o.signals.offTaskSeconds > 0 ? 'glance' : 'on'
}

const FILL: Record<Kind, string> = {
  on: 'bg-accent',
  glance: 'bg-accent/55',
  off: 'bg-warn',
  break: 'bg-border-strong',
  unknown: 'bg-surface',
}

/**
 * A session at a glance: one cell per window, coloured by what the assessment said, with a mark
 * above every window where the system did something. Silence is the green.
 */
export function Strip({
  observations,
  size = 'md',
  linkPrefix,
}: {
  observations: Observation[]
  size?: 'sm' | 'md'
  linkPrefix?: string
}) {
  return (
    <div className="flex w-full flex-col gap-1">
      {size === 'md' ? (
        <div className="flex h-3 gap-px" aria-hidden="true">
          {observations.map((o) => (
            <span key={o.id} className="flex flex-1 justify-center">
              {o.tier > 0 ? (
                <span
                  className={cn(
                    'w-0.5 rounded-pill',
                    o.tier >= 4 ? 'h-3 bg-danger' : o.tier >= 2 ? 'h-3 bg-warn' : 'h-2 bg-accent',
                  )}
                />
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className={cn(
          'flex w-full gap-px overflow-hidden rounded-xs',
          size === 'md' ? 'h-7' : 'h-2',
        )}
      >
        {observations.map((o) => {
          const cell = (
            <span
              className={cn('block h-full w-full', FILL[kindOf(o)])}
              title={`${clock(o.ts)} · ${o.assessment?.because ?? 'no assessment'}`}
            />
          )
          return linkPrefix ? (
            <a key={o.id} href={`${linkPrefix}#${o.id}`} className="flex-1 hover:opacity-70">
              {cell}
            </a>
          ) : (
            <span key={o.id} className="flex-1">
              {cell}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function StripLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-caption text-text-faint">
      {(
        [
          ['on', 'on the goal'],
          ['glance', 'brief glance away'],
          ['off', 'off task'],
          ['break', 'break'],
        ] as const
      ).map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', FILL[k])} />
          {label}
        </span>
      ))}
    </div>
  )
}
