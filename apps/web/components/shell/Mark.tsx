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

/** "lumi", with the dot over the i drawn as the light. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span aria-label="Lumi" role="img" className={cn('inline-flex items-baseline text-text', className)}>
      <span aria-hidden="true" className="text-[25px] font-bold leading-none tracking-[-0.045em]">
        lum
        <span className="relative inline-block">
          ı
          <span className="absolute left-[calc(50%-0.03em)] top-[0.07em] size-[0.25em] -translate-x-1/2 rounded-pill bg-accent" />
        </span>
      </span>
    </span>
  )
}
