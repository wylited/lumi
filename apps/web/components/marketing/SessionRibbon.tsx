import { cn } from '@heli/ui'

type State = 'focus' | 'glance' | 'drift' | 'break'

const FILL: Record<State, string> = { focus: 'bg-accent', glance: 'bg-jade-300', drift: 'bg-warn', break: 'bg-ink-200' }

/**
 * An illustration of a forty-minute session, one letter a minute: f focus, g a glance away,
 * d drift, b break; a 2 or 3 after it is a nudge or a spoken line. The desktop draws the same ribbon.
 */
const SESSION = 'g f f f f f f g f f g g d d2 d3 f f f f f f f f f f b b b b b f g f f d g f f f f'
  .split(' ')
  .map((m, i) => ({
    id: i,
    state: ({ f: 'focus', g: 'glance', d: 'drift', b: 'break' } as const)[m[0] as 'f' | 'g' | 'd' | 'b'],
    tier: Number(m[1] ?? 0),
  }))

export function SessionRibbon() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 gap-[3px]" aria-hidden="true">
        {SESSION.map((o) => (
          <span key={o.id} className="flex flex-1 justify-center">
            {o.tier >= 2 ? <span className={cn('h-full w-[2px] rounded-pill', o.tier >= 3 ? 'bg-text' : 'bg-warn')} /> : null}
          </span>
        ))}
      </div>
      <div className="flex h-10 gap-[3px] md:h-14" role="img" aria-label="A forty-minute session: mostly focused, one drift to YouTube, a break, one short drift">
        {SESSION.map((o) => (
          <span key={o.id} className={cn('flex-1 rounded-[3px]', FILL[o.state])} />
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
        Voice
      </span>
    </div>
  )
}
