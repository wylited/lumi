import type { Observation } from '@heli/contracts'
import { OUTCOME, VERB } from './states'

/**
 * What the system did, one row per intervention. Time, verb, the words it used, and whether it
 * worked. Ambient changes are left out: they are the tray's job, not a list's.
 */
export function Actions({
  observations,
  settled = () => true,
  empty,
}: {
  observations: Observation[]
  /** Whether a row's outcome is final. Live rows are pending until the next minute. */
  settled?: (o: Observation) => boolean
  empty: string
}) {
  const rows = observations.map((o, i) => ({ o, minute: i + 1 })).filter(({ o }) => o.tier >= 2)
  if (rows.length === 0) return <p className="text-small text-text-faint">{empty}</p>
  return (
    <ol className="flex flex-col divide-y divide-border">
      {rows
        .slice()
        .reverse()
        .map(({ o, minute }) => {
          const outcome = settled(o) && o.outcome ? OUTCOME[o.outcome] : null
          return (
            <li
              key={o.id}
              className="grid grid-cols-[44px_64px_1fr_auto] items-baseline gap-3 py-3"
            >
              <span className="tnum text-small text-text-faint">{minute}m</span>
              <span className="text-small font-medium text-text">
                {VERB[o.tier] ?? `Tier ${o.tier}`}
              </span>
              <span className="min-w-0 truncate text-small text-text-muted">
                {o.action?.message ?? ''}
              </span>
              <span className={`text-small ${outcome?.className ?? 'text-text-faint'}`}>
                {outcome?.label ?? '…'}
              </span>
            </li>
          )
        })}
    </ol>
  )
}
