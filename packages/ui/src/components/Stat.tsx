import type { ReactNode } from 'react'
import { cn } from '../cn'

export interface StatProps {
  label: string
  value: ReactNode
  unit?: string
  /** One quiet line under the figure: a comparison, a denominator, a caveat. */
  hint?: ReactNode
  size?: 'md' | 'lg'
  className?: string
}

/** A number that can be read from across the room. Tabular, one unit, no decoration. */
export function Stat({ label, value, unit, hint, size = 'md', className }: StatProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-label uppercase text-text-faint">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span
          className={cn(
            'tnum font-semibold text-text',
            size === 'lg' ? 'text-display-2' : 'text-title-1',
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-small text-text-muted">{unit}</span> : null}
      </span>
      {hint ? <span className="text-caption text-text-faint">{hint}</span> : null}
    </div>
  )
}
