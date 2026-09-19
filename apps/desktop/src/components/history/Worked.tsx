import type { TierEffect } from '../../lib/analytics'

const NAME: Record<number, string> = { 1: 'Light', 2: 'Nudge', 3: 'Voice', 4: 'Change' }

/** Share of interruptions after which you came back within two minutes. */
export function Worked({ effects, best }: { effects: TierEffect[]; best: TierEffect | null }) {
  if (!effects.length)
    return <p className="text-small text-text-faint">Nothing needed doing yet.</p>
  return (
    <ul className="flex flex-col gap-3.5">
      {effects.map((e) => {
        const top = best?.tier === e.tier
        return (
          <li key={e.tier} className="grid grid-cols-[104px_1fr_44px] items-center gap-3">
            <span className={`text-small ${top ? 'font-semibold text-text' : 'text-text-muted'}`}>
              {NAME[e.tier] ?? `Tier ${e.tier}`}
            </span>
            <span
              className="h-2 overflow-hidden rounded-pill bg-ink-100"
              title={`${e.resolved} of ${e.judged}`}
            >
              <span
                className="block h-full rounded-pill bg-accent"
                style={{ width: `${(e.rate ?? 0) * 100}%` }}
              />
            </span>
            <span
              className={`tnum text-right text-small ${top ? 'font-semibold text-text' : 'text-text-muted'}`}
            >
              {e.rate === null ? '—' : `${Math.round(e.rate * 100)}%`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
