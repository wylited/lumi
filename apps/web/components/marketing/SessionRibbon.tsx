import type { Observation } from '@heli/contracts'
import { fixtures, SEED_SESSION_ID } from '@heli/fixtures'
import { cn } from '@heli/ui'

type State = 'focus' | 'glance' | 'drift' | 'break'

function stateOf(o: Observation): State {
  const a = o.assessment
  if (a?.activity === 'break') return 'break'
  if (a && !a.onTask) return 'drift'
  return o.signals.offTaskSeconds > 0 ? 'glance' : 'focus'
}

const FILL: Record<State, string> = { focus: 'bg-accent', glance: 'bg-jade-300', drift: 'bg-warn', break: 'bg-ink-200' }

/** The seeded demo session, minute by minute — the same ribbon the Mac app draws. */
export function SessionRibbon() {
  const obs = fixtures().session(SEED_SESSION_ID)?.observations ?? []
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 gap-[3px]" aria-hidden="true">
        {obs.map((o) => (
          <span key={o.id} className="flex flex-1 justify-center">
            {o.tier >= 2 ? <span className={cn('h-full w-[2px] rounded-pill', o.tier >= 3 ? 'bg-text' : 'bg-warn')} /> : null}
          </span>
        ))}
      </div>
      <div className="flex h-10 gap-[3px] md:h-14" role="img" aria-label="A forty-minute session: mostly focused, one drift to YouTube, a break, one short drift">
        {obs.map((o) => (
          <span key={o.id} className={cn('flex-1 rounded-[3px]', FILL[stateOf(o)])} />
        ))}
      </div>
      <div className="flex justify-between text-caption text-text-faint">
        <span>0</span>
        <span>40 min</span>
      </div>
    </div>
  )
}

export function RibbonKey() {
  const items: Array<[string, string]> = [
    ['bg-accent', 'Focused'],
    ['bg-warn', 'Off task'],
    ['bg-ink-200', 'Break'],
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-small text-text-muted">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-2">
          <span className={cn('size-2.5 rounded-[3px]', c)} />
          {l}
        </span>
      ))}
      <span className="inline-flex items-center gap-2">
        <span className="h-3 w-[2px] rounded-pill bg-warn" />
        Nudge
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="h-3 w-[2px] rounded-pill bg-text" />
        Spoken line
      </span>
    </div>
  )
}
