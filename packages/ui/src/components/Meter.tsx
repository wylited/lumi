import { cn } from '../cn'

export interface MeterProps {
  /** In [0, 1]. */
  value: number
  tone?: 'accent' | 'warn' | 'danger' | 'neutral'
  label: string
  className?: string
}

const tones = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-ink-300',
} as const

export function Meter({ value, tone = 'accent', label, className }: MeterProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('h-1.5 w-full overflow-hidden rounded-pill bg-border', className)}
    >
      <div
        className={cn(
          'h-full rounded-pill transition-[width] duration-slow ease-heli',
          tones[tone],
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
