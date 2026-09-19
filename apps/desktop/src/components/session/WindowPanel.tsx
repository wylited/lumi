import type { SignalWindow } from '@heli/contracts'
import { cn, KeyValue, Pill } from '@heli/ui'
import { dur } from './format'

/** The last minute of the machine, as the assessment saw it. Counts and titles only. */
export function WindowPanel({ window: w }: { window: SignalWindow | null }) {
  if (!w) return <p className="text-small text-text-faint">No window yet.</p>
  const rows = [
    ...w.topSites.map((s) => ({ name: s.title, seconds: s.seconds, onTask: s.onTask, site: true })),
    ...w.topApps
      .filter((a) => !w.topSites.length || a.app !== 'Safari')
      .map((a) => ({ name: a.app, seconds: a.seconds, onTask: a.onTask, site: false })),
  ]
  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2.5">
        {rows.length === 0 ? (
          <li className="text-small text-text-faint">Nothing in front — away from the machine.</li>
        ) : null}
        {rows.map((r) => (
          <li key={`${r.name}${r.site}`} className="flex items-center gap-3">
            <span
              className={cn('size-1.5 shrink-0 rounded-pill', r.onTask ? 'bg-accent' : 'bg-warn')}
            />
            <span className="min-w-0 flex-1 truncate text-small text-text">{r.name}</span>
            {r.site ? <span className="font-mono text-[10px] text-text-faint">title</span> : null}
            <span className="tnum text-small text-text-muted">{dur(r.seconds)}</span>
          </li>
        ))}
      </ul>
      <KeyValue
        items={[
          { key: 'Input', value: `${Math.round(w.inputRate)} / 30s` },
          { key: 'Idle', value: dur(w.idleSeconds) },
          { key: 'Switches', value: String(w.contextSwitches) },
          { key: 'Focus mode', value: w.focusMode ? <Pill tone="accent">on</Pill> : 'off' },
        ]}
      />
    </div>
  )
}
