import type { ReactNode } from 'react'
import { cn } from '@heli/ui'

/** The desktop's own small vocabulary: flat, sentence-case, numbers first. */

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-6">
      <h1 className="text-title-1 font-semibold tracking-tight text-text">{children}</h1>
      {aside}
    </div>
  )
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="text-body-strong font-semibold text-text">{children}</h2>
      {aside ? <span className="text-small text-text-faint">{aside}</span> : null}
    </div>
  )
}

/** A number and what it is. No box, no caption paragraph. */
export function Figure({ value, label, tone }: { value: ReactNode; label: string; tone?: 'warn' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'tnum text-title-1 font-semibold tracking-tight',
          tone === 'warn' ? 'text-warn' : 'text-text',
        )}
      >
        {value}
      </span>
      <span className="text-small text-text-faint">{label}</span>
    </div>
  )
}

/** macOS-style grouped rows. */
export function Group({
  title,
  footer,
  children,
}: {
  title?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      {title ? <h2 className="px-1 text-small font-medium text-text-muted">{title}</h2> : null}
      <div className="divide-y divide-border rounded-md border border-border bg-bg">{children}</div>
      {footer ? <p className="px-1 text-caption text-text-faint">{footer}</p> : null}
    </section>
  )
}

export function Row({
  label,
  detail,
  children,
  align = 'center',
}: {
  label: ReactNode
  detail?: ReactNode
  children?: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div
      className={cn(
        'flex min-h-12 justify-between gap-6 px-4 py-2.5',
        align === 'center' ? 'items-center' : 'items-start',
      )}
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-body text-text">{label}</span>
        {detail ? <span className="text-small text-text-faint">{detail}</span> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

export function Dot({ tone }: { tone: 'focus' | 'drift' | 'idle' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-pill',
        tone === 'focus' ? 'bg-accent' : tone === 'drift' ? 'bg-warn' : 'bg-ink-300',
      )}
    />
  )
}
