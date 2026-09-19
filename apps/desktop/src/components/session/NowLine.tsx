import type { Observation } from '@heli/contracts'
import { cn, LiveDot } from '@heli/ui'
import { dur } from './format'

/** The current assessment, in one line you can read from across the desk. */
export function NowLine({ latest, speaking }: { latest: Observation | null; speaking: boolean }) {
  const a = latest?.assessment
  const off = a && !a.onTask
  const brk = a?.activity === 'break'
  const where = latest?.signals.topSites[0]?.title ?? latest?.signals.topApps[0]?.app ?? null

  const headline = !a
    ? 'Settling in'
    : brk
      ? 'On a break'
      : off
        ? a.kind === 'phone'
          ? 'Phone out'
          : `Drifting${where ? ` to ${where}` : ''}`
        : 'On the goal'

  const detail = !a
    ? 'The first window lands within a minute.'
    : brk
      ? 'The break you scheduled. Nothing will interrupt it.'
      : off
        ? `${dur(a.driftSeconds)} off the goal${a.kind && a.kind !== 'phone' ? ` · ${a.kind}` : ''}. It is watching whether you come back.`
        : `${cap(a.activity)}${where ? ` in ${where}` : ''}. ${a.because}`

  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border px-6 py-5 transition-colors duration-slow ease-heli',
        off ? 'border-warn/40 bg-warn-wash' : 'border-border bg-surface',
      )}
    >
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-pill',
          off ? 'bg-warn/15' : 'bg-accent-wash',
        )}
      >
        {off ? (
          <span className="size-2.5 rounded-pill bg-warn" />
        ) : (
          <LiveDot state={speaking ? 'speaking' : 'live'} />
        )}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-title-2 font-semibold text-text">
          {speaking ? 'Speaking' : headline}
        </span>
        <span className="truncate text-small text-text-muted">{detail}</span>
      </div>
      {a ? (
        <span
          className="tnum ml-auto shrink-0 font-mono text-[11px] text-text-faint"
          title="Assessment confidence"
        >
          {Math.round(a.confidence * 100)}% sure
        </span>
      ) : null}
    </div>
  )
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
