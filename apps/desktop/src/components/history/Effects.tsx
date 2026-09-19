import { Pill, TierBadge } from '@heli/ui'
import type { TierEffect } from '../../lib/analytics'

const WHAT: Record<number, string> = {
  1: 'Tray and desk light',
  2: 'Notification',
  3: 'Spoken line',
  4: 'Machine change',
}

export function Effects({ effects, best }: { effects: TierEffect[]; best: TierEffect | null }) {
  if (!effects.length)
    return <p className="text-small text-text-faint">Nothing has needed doing yet.</p>
  return (
    <ul className="flex flex-col gap-4">
      {effects.map((e) => (
        <li key={e.tier} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <TierBadge tier={e.tier} compact />
            <span className="flex-1 text-small text-text">{WHAT[e.tier] ?? `Tier ${e.tier}`}</span>
            {best?.tier === e.tier ? (
              <Pill tone="accent" className="!py-0.5">
                works best
              </Pill>
            ) : null}
            <span className="tnum w-12 text-right text-body-strong font-semibold text-text">
              {e.rate === null ? '—' : `${Math.round(e.rate * 100)}%`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-border-strong/50">
              <div
                className="h-full rounded-pill bg-accent"
                style={{ width: `${(e.rate ?? 0) * 100}%` }}
              />
            </div>
            <span className="tnum w-[92px] text-right text-caption text-text-faint">
              {e.resolved} of {e.judged} back
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}
