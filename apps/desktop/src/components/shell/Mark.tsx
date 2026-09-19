import { cn } from '@heli/ui'

/**
 * The mark: a lowercase h whose arch hovers over one dot — the unit's single dim light, watching.
 * One stroke weight, round ends; the dot is the only colour.
 */
export function Mark({ className, dot = 'fill-accent' }: { className?: string; dot?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('size-6', className)}>
      <path
        d="M6.5 3v18M6.5 13a5.5 5.5 0 0 1 11 0v8"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="15.4" r="2.4" className={dot} />
    </svg>
  )
}
