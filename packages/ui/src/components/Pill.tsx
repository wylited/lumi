import type { HTMLAttributes } from 'react'
import { cn } from '../cn'

export type PillTone = 'neutral' | 'accent' | 'warn' | 'danger'

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone
  dot?: boolean
}

const tones: Record<PillTone, string> = {
  neutral: 'bg-surface text-text-muted border-border',
  accent: 'bg-accent-wash text-accent-link border-accent/25',
  warn: 'bg-warn-wash text-text border-warn/40',
  danger: 'bg-danger-wash text-text border-danger/40',
}

export function Pill({ tone = 'neutral', dot = false, className, children, ...props }: PillProps) {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1',
        'font-mono text-[11px] leading-none tracking-wide',
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-pill bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
