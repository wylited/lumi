import { cn } from '@heli/ui'

/** The mark: a rotor over an eye. It watches, and it moves. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', className)}>
      <rect width="24" height="24" rx="6.5" className="fill-accent-strong" />
      <rect x="4.5" y="6.2" width="15" height="2.1" rx="1.05" className="fill-accent-contrast" />
      <rect x="11" y="7.5" width="2" height="4" className="fill-accent-contrast" />
      <circle cx="12" cy="15" r="3.6" className="fill-accent-contrast" />
      <circle cx="12" cy="15" r="1.4" className="fill-accent-strong" />
    </svg>
  )
}
