import { useEffect, useState } from 'react'
import type { Observation, Outcome, SessionDetail } from '@heli/contracts'
import { KeyValue, Pill, Sheet, TierBadge, type PillTone } from '@heli/ui'
import { api } from '../../lib/api'
import { clock, dur, mins } from '../session/format'

const OUTCOME: Record<Outcome, { tone: PillTone; label: string }> = {
  resolved: { tone: 'accent', label: 'back on task' },
  ignored: { tone: 'warn', label: 'ignored' },
  reverted: { tone: 'danger', label: 'undone' },
  unknown: { tone: 'neutral', label: 'not judged' },
}

function cell(o: Observation) {
  const a = o.assessment
  if (!a) return 'bg-surface'
  if (a.activity === 'break') return 'bg-border-strong'
  if (!a.onTask) return 'bg-warn'
  return o.signals.offTaskSeconds > 0 ? 'bg-accent/55' : 'bg-accent'
}

/** One session replayed: the strip, then only the moments the system acted, with what happened. */
export function SessionSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null)
  useEffect(() => {
    setS(null)
    if (id) void api.session(id).then(setS)
  }, [id])

  const acted = s?.observations.filter((o) => o.tier > 0) ?? []
  return (
    <Sheet
      open={id !== null}
      onClose={onClose}
      title={s ? `${clock(s.startedAt)} · ${s.goal?.objective ?? 'Session'}` : 'Session'}
    >
      {!s ? (
        <p className="text-small text-text-faint">Loading…</p>
      ) : (
        <div className="flex flex-col gap-7">
          {s.summary?.message ? (
            <p className="text-body text-text-muted">{s.summary.message}</p>
          ) : null}
          <div className="flex h-6 gap-px overflow-hidden rounded-xs">
            {s.observations.map((o) => (
              <span
                key={o.id}
                className={`flex-1 ${cell(o)}`}
                title={`${clock(o.ts)} · ${o.assessment?.because ?? ''}`}
              />
            ))}
          </div>
          {s.summary ? (
            <KeyValue
              items={[
                { key: 'Focused', value: `${mins(s.summary.focusedMinutes)} min` },
                { key: 'Off task', value: `${mins(s.summary.offTaskMinutes)} min` },
                { key: 'Longest run', value: dur(s.summary.longestFocusRunSeconds) },
                { key: 'Top distraction', value: s.summary.topDistraction ?? 'none' },
                {
                  key: 'Silent windows',
                  value: `${s.observations.length - acted.length} of ${s.observations.length}`,
                },
              ]}
            />
          ) : null}
          <div className="flex flex-col gap-3">
            <span className="text-label uppercase text-text-faint">What it did</span>
            {acted.length === 0 ? (
              <p className="text-small text-text-faint">Nothing. The whole session was silent.</p>
            ) : null}
            {acted.map((o) => (
              <div key={o.id} className="flex flex-col gap-2 rounded-md border border-border p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="tnum font-mono text-[11px] text-text-faint">{clock(o.ts)}</span>
                  <TierBadge tier={o.tier} />
                  {o.outcome ? (
                    <Pill tone={OUTCOME[o.outcome].tone} dot className="ml-auto">
                      {OUTCOME[o.outcome].label}
                    </Pill>
                  ) : null}
                </div>
                {o.action?.message ? (
                  <p className="text-small text-text">“{o.action.message}”</p>
                ) : null}
                {o.assessment ? (
                  <p className="text-caption text-text-faint">{o.assessment.because}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  )
}
