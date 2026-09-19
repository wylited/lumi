import { cn } from '../cn'

export type TierLevel = 0 | 1 | 2 | 3 | 4 | 5

export const TIER_NAMES: Record<TierLevel, string> = {
  0: 'silent',
  1: 'ambient',
  2: 'nudge',
  3: 'speak',
  4: 'automate',
  5: 'summary',
}

/** Tone rises with the tier: the louder the system got, the more the badge says so. */
const tones: Record<TierLevel, { text: string; bar: string; wash: string }> = {
  0: { text: 'text-text-faint', bar: 'bg-ink-300', wash: 'bg-surface border-border' },
  1: { text: 'text-accent-link', bar: 'bg-accent', wash: 'bg-accent-wash border-accent/25' },
  2: { text: 'text-text', bar: 'bg-warn', wash: 'bg-warn-wash border-warn/40' },
  3: { text: 'text-ink-900', bar: 'bg-ink-900', wash: 'bg-warn border-warn' },
  4: { text: 'text-ink-50', bar: 'bg-ink-50', wash: 'bg-danger border-danger' },
  5: { text: 'text-text-muted', bar: 'bg-text-muted', wash: 'bg-surface border-border-strong' },
}

export interface TierBadgeProps {
  tier: number
  /** Hide the name and keep the ladder — for dense tables. */
  compact?: boolean
  className?: string
}

export function TierBadge({ tier, compact = false, className }: TierBadgeProps) {
  const t = Math.min(5, Math.max(0, Math.round(tier))) as TierLevel
  const tone = tones[t]
  const rungs = t === 5 ? 0 : 4
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-2 py-[3px]',
        'font-mono text-[11px] leading-none tracking-wide',
        tone.wash,
        tone.text,
        className,
      )}
      title={`Tier ${t} · ${TIER_NAMES[t]}`}
    >
      {rungs ? (
        <span aria-hidden="true" className="flex h-2.5 items-end gap-[2px]">
          {Array.from({ length: rungs }, (_, i) => (
            <span
              key={i}
              className={cn(
                'w-[3px] rounded-[1px]',
                i < t ? tone.bar : t >= 3 ? 'bg-current opacity-30' : 'bg-border-strong',
              )}
              style={{ height: `${40 + i * 20}%` }}
            />
          ))}
        </span>
      ) : null}
      <span className="tnum">T{t}</span>
      {compact ? <span className="sr-only">{TIER_NAMES[t]}</span> : <span>{TIER_NAMES[t]}</span>}
    </span>
  )
}
