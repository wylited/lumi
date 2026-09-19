import { cn } from '@heli/ui'

/**
 * The mark: one light. Lumi One watches with a single dim dot, so the dot is the logo — a jade
 * light with a faint halo. Only the halo's wash and the dot carry colour.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', className)}>
      <circle cx="12" cy="12" r="10" className="fill-accent-wash" />
      <circle cx="12" cy="12" r="5.5" className="fill-accent" />
    </svg>
  )
}
