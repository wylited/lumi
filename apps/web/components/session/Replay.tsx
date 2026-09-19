import type { Observation, Outcome } from '@heli/contracts'
import { Pill, TierBadge, type PillTone } from '@heli/ui'
import { clock, duration } from '@/lib/format'

type Block = { kind: 'silent'; items: Observation[] } | { kind: 'loud'; item: Observation }

/** Runs of silent windows fold into one row of ticks; anything the system did gets a card. */
function blocks(observations: Observation[]): Block[] {
  const out: Block[] = []
  for (const o of observations) {
    const last = out[out.length - 1]
    if (o.tier === 0) {
      if (last?.kind === 'silent') last.items.push(o)
      else out.push({ kind: 'silent', items: [o] })
    } else out.push({ kind: 'loud', item: o })
  }
  return out
}

const OUTCOME: Record<Outcome, { tone: PillTone; label: string }> = {
  resolved: { tone: 'accent', label: 'back on task' },
  ignored: { tone: 'warn', label: 'ignored' },
  reverted: { tone: 'danger', label: 'undone' },
  unknown: { tone: 'neutral', label: 'not judged' },
}

const CHANNEL: Record<string, string> = {
  ambient: 'Tray and desk light went amber',
  notification: 'Notification',
  speech: 'Said out loud',
  automation: 'Changed the machine',
  summary: 'Summary',
}

export function Replay({ observations }: { observations: Observation[] }) {
  return (
    <ol className="relative flex flex-col">
      <span aria-hidden="true" className="absolute bottom-2 left-[5px] top-2 w-px bg-border" />
      {blocks(observations).map((b) =>
        b.kind === 'silent' ? (
          <SilentRun key={b.items[0]!.id} items={b.items} />
        ) : (
          <Card key={b.item.id} o={b.item} />
        ),
      )}
    </ol>
  )
}

function SilentRun({ items }: { items: Observation[] }) {
  const first = items[0]!
  const last = items[items.length - 1]!
  const breaks = items.filter((o) => o.assessment?.activity === 'break').length
  return (
    <li className="relative py-3 pl-8">
      <span
        aria-hidden="true"
        className="absolute left-[3px] top-[18px] size-[5px] rounded-pill bg-border-strong"
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="tnum font-mono text-[11px] text-text-faint">
          {clock(first.signals.from)}–{clock(last.ts)}
        </span>
        <span className="flex items-end gap-[3px]" aria-hidden="true">
          {items.map((o) => (
            <a
              key={o.id}
              id={o.id}
              href={`#${o.id}`}
              title={`${clock(o.ts)} · ${o.assessment?.because ?? ''}`}
              className={`block w-[3px] rounded-pill ${o.assessment?.activity === 'break' ? 'h-2 bg-border-strong' : 'h-3 bg-accent/60 hover:bg-accent'}`}
            />
          ))}
        </span>
        <span className="text-caption text-text-faint">
          {items.length} silent {items.length === 1 ? 'window' : 'windows'}
          {breaks ? ` · ${breaks} on break` : ''}
        </span>
      </div>
    </li>
  )
}

function Card({ o }: { o: Observation }) {
  const a = o.assessment
  const act = o.action
  const outcome = o.outcome ? OUTCOME[o.outcome] : null
  const quoted = act?.message && (act.channel === 'speech' || act.channel === 'notification')
  return (
    <li
      id={o.id}
      className="relative scroll-mt-24 py-3 pl-8 target:[&>div]:ring-2 target:[&>div]:ring-accent"
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[26px] size-[11px] rounded-pill border-2 border-bg ${o.tier >= 2 ? 'bg-warn' : 'bg-accent'}`}
      />
      <div className="rounded-md border border-border bg-surface-raised p-5 transition-shadow">
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`#${o.id}`}
            className="tnum font-mono text-[11px] text-text-faint hover:text-text"
          >
            {clock(o.ts)}
          </a>
          <TierBadge tier={o.tier} />
          <span className="text-small font-medium text-text">
            {act ? (CHANNEL[act.channel] ?? act.channel) : 'Logged'}
          </span>
          {outcome ? (
            <Pill tone={outcome.tone} dot className="ml-auto">
              {outcome.label}
            </Pill>
          ) : null}
        </div>

        {quoted ? (
          <blockquote className="mt-4 border-l-2 border-accent pl-4 text-body text-text">
            “{act.message}”
          </blockquote>
        ) : null}

        {a ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-small text-text-muted">{a.because}</p>
            <div className="flex flex-wrap gap-1.5">
              {a.evidence.map((e) => (
                <span
                  key={e}
                  className="rounded-xs bg-surface px-2 py-1 font-mono text-[11px] text-text-muted"
                >
                  {e}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-text-faint">
              <span>
                drift <span className="tnum text-text-muted">{duration(a.driftSeconds)}</span>
              </span>
              <span>
                confidence <span className="tnum text-text-muted">{a.confidence.toFixed(2)}</span>
              </span>
              {o.latencyMs !== null ? (
                <span>
                  assessed in{' '}
                  <span className="tnum text-text-muted">{(o.latencyMs / 1000).toFixed(1)}s</span>
                </span>
              ) : null}
              {o.reason ? <span className="font-mono">{o.reason}</span> : null}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  )
}
