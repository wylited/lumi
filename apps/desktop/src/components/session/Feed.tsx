import type { Observation, Outcome } from '@heli/contracts'
import { Pill, TierBadge, type PillTone } from '@heli/ui'
import { settledOutcome, type LiveSnapshot } from '../../lib/live'
import { dur } from './format'

type Block = { kind: 'quiet'; items: Observation[] } | { kind: 'act'; item: Observation }

const OUTCOME: Record<Outcome, { tone: PillTone; label: string }> = {
  resolved: { tone: 'accent', label: 'back on task' },
  ignored: { tone: 'warn', label: 'ignored' },
  reverted: { tone: 'danger', label: 'undone' },
  unknown: { tone: 'neutral', label: 'not judged' },
}

const CHANNEL: Record<string, string> = {
  ambient: 'Tray went amber',
  notification: 'Nudged',
  speech: 'Said out loud',
  automation: 'Changed the machine',
  summary: 'Summary',
}

/** Newest first. Silence folds into one quiet line; anything the system did is a row of its own. */
export function Feed({ snap }: { snap: LiveSnapshot }) {
  // Session time, not wall time: "minute 14" is what matters while you work, and it stays honest
  // when the demo runs the clock fast.
  const at = (o: Observation) => `${snap.observations.indexOf(o) + 1}′`
  const blocks: Block[] = []
  for (const o of snap.observations) {
    const last = blocks[blocks.length - 1]
    if (o.tier === 0) {
      if (last?.kind === 'quiet') last.items.push(o)
      else blocks.push({ kind: 'quiet', items: [o] })
    } else blocks.push({ kind: 'act', item: o })
  }
  blocks.reverse()

  return (
    <ol className="flex flex-col">
      {blocks.map((b, i) =>
        b.kind === 'quiet' ? (
          <li key={b.items[0]!.id} className="flex items-center gap-3 py-2.5">
            <span className="tnum w-11 shrink-0 font-mono text-[11px] text-text-faint">
              {at(b.items[b.items.length - 1]!)}
            </span>
            <span className="flex items-end gap-[3px]" aria-hidden="true">
              {b.items.slice(-24).map((o) => (
                <span
                  key={o.id}
                  className={`w-[3px] rounded-pill ${o.assessment?.activity === 'break' ? 'h-2 bg-border-strong' : 'h-3 bg-accent/60'}`}
                />
              ))}
            </span>
            <span className="text-caption text-text-faint">
              {i === 0 ? `Quiet for ${b.items.length} min` : `${b.items.length} quiet min`}
            </span>
          </li>
        ) : (
          <Act key={b.item.id} o={b.item} snap={snap} at={at(b.item)} />
        ),
      )}
    </ol>
  )
}

function Act({ o, snap, at }: { o: Observation; snap: LiveSnapshot; at: string }) {
  const outcome = settledOutcome(snap, o)
  const act = o.action
  return (
    <li className="my-1.5 rounded-md border border-border bg-surface-raised px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="tnum w-11 shrink-0 font-mono text-[11px] text-text-faint">{at}</span>
        <TierBadge tier={o.tier} />
        <span className="text-small font-medium text-text">
          {act ? (CHANNEL[act.channel] ?? act.channel) : 'Logged'}
        </span>
        <span className="ml-auto">
          {outcome ? (
            <Pill tone={OUTCOME[outcome].tone} dot>
              {OUTCOME[outcome].label}
            </Pill>
          ) : (
            <Pill>judging…</Pill>
          )}
        </span>
      </div>
      {act?.message ? <p className="mt-2 pl-14 text-small text-text">“{act.message}”</p> : null}
      {o.assessment ? (
        <p className="mt-1 pl-14 text-caption text-text-faint">
          {o.assessment.because} · drift {dur(o.assessment.driftSeconds)}
        </p>
      ) : null}
    </li>
  )
}
