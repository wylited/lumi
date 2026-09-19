import { cn } from '@heli/ui'

/** The mark: a rotor over an eye. It watches, and it moves. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', className)}>
      <rect width="24" height="24" rx="7" className="fill-accent-strong" />
      <rect x="4.5" y="6.5" width="15" height="2" rx="1" className="fill-accent-contrast" />
      <rect x="11" y="8" width="2" height="3" className="fill-accent-contrast" />
      <circle cx="12" cy="15" r="3.25" className="fill-accent-contrast" />
      <circle cx="12" cy="15" r="1.25" className="fill-accent-strong" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <Mark />
      <span className="text-title-3 font-semibold tracking-tight text-text">Helicopter</span>
    </span>
  )
}
