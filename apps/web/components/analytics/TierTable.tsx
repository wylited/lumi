import { Pill, TIER_NAMES, TierBadge, type TierLevel } from '@heli/ui'
import { percent } from '@/lib/format'
import { MIN_SAMPLES, type TierEffect } from './derive'

const WHAT: Record<number, string> = {
  1: 'Tray turns amber, desk LED shifts',
  2: 'A notification with “Back to the goal”',
  3: 'One sentence, out loud, interruptible',
  4: 'A reversible change to the machine',
}

export function TierTable({ effects, best }: { effects: TierEffect[]; best: TierEffect | null }) {
  const max = Math.max(1, ...effects.map((e) => e.total))
  return (
    <div className="flex flex-col divide-y divide-border">
      {effects.map((e) => {
        const judged = e.total - e.unknown
        const thin = judged < MIN_SAMPLES
        return (
          <div
            key={e.tier}
            className="grid grid-cols-[112px_1fr_72px] items-center gap-5 py-4 first:pt-1"
          >
            <TierBadge tier={e.tier} />
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-small text-text-muted">
                  {WHAT[e.tier] ?? TIER_NAMES[e.tier as TierLevel]}
                </span>
                <span className="tnum shrink-0 text-caption text-text-faint">
                  {e.resolved} of {judged} back
                  {e.unknown ? ` · ${e.unknown} unjudged` : ''}
                </span>
              </div>
              {/* Bar length is volume; the filled part is what worked. */}
              <div
                className="h-2 rounded-pill bg-surface"
                style={{ width: `${Math.max(8, (e.total / max) * 100)}%` }}
              >
                <div className="flex h-full overflow-hidden rounded-pill">
                  <span
                    className="h-full bg-accent"
                    style={{ width: `${(e.resolved / e.total) * 100}%` }}
                  />
                  <span
                    className="h-full bg-warn/70"
                    style={{ width: `${(e.ignored / e.total) * 100}%` }}
                  />
                  <span
                    className="h-full bg-danger/70"
                    style={{ width: `${(e.reverted / e.total) * 100}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={`tnum text-title-3 font-semibold ${thin ? 'text-text-faint' : 'text-text'}`}
              >
                {e.rate === null ? '—' : percent(e.rate)}
              </span>
              {best?.tier === e.tier ? (
                <Pill tone="accent" className="whitespace-nowrap !px-1.5 !py-0.5 !text-[10px]">
                  works best
                </Pill>
              ) : thin ? (
                <span className="text-[10px] text-text-faint">few samples</span>
              ) : null}
            </div>
          </div>
        )
      })}
      <div className="flex items-center gap-4 pt-4 text-caption text-text-faint">
        <Legend className="bg-accent" label="back on task" />
        <Legend className="bg-warn/70" label="ignored" />
        <Legend className="bg-danger/70" label="undone" />
      </div>
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-pill ${className}`} />
      {label}
    </span>
  )
}
