import { Stat } from '@heli/ui'
import type { Derived } from '../../lib/live'
import { dur, mins } from './format'

export function Metrics({ d }: { d: Derived }) {
  const tracked = d.focusedMinutes + d.offTaskMinutes
  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border">
      <Cell>
        <Stat
          label="Focused"
          value={mins(d.focusedMinutes)}
          unit="min"
          hint={tracked ? `${Math.round((d.focusedMinutes / tracked) * 100)}% of the session` : ' '}
        />
      </Cell>
      <Cell>
        <Stat label="Off task" value={mins(d.offTaskMinutes)} unit="min" hint=" " />
      </Cell>
      <Cell>
        <Stat
          label="Switches"
          value={String(d.switches)}
          hint={d.minutes ? `${(d.switches / d.minutes).toFixed(1)} a minute` : ' '}
        />
      </Cell>
      <Cell>
        <Stat
          label="Longest focus"
          value={dur(d.longestRunSeconds)}
          hint={d.currentRunSeconds ? `current run ${dur(d.currentRunSeconds)}` : 'run broken'}
        />
      </Cell>
    </div>
  )
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div className="bg-bg px-5 py-4">{children}</div>
}
