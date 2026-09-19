import type { ReactNode } from 'react'
import { cn } from '@heli/ui'

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cn('mx-auto w-full max-w-[var(--max-content)] px-5 pb-24 pt-10', className)}>
      {children}
    </main>
  )
}

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? <span className="text-label uppercase text-text-faint">{eyebrow}</span> : null}
        <h1 className="text-display-2 font-semibold text-balance text-text">{title}</h1>
        {lede ? <p className="measure text-body text-text-muted">{lede}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-4', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-title-3 font-semibold text-text">{title}</h2>
        {aside ? <div className="text-small text-text-faint">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}
