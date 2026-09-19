import type { ReactNode } from 'react'
import { cn } from '../cn'

export interface EmptyStateProps {
  title: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border px-6 py-14 text-center',
        className,
      )}
    >
      <p className="max-w-[42ch] text-body-strong text-text-muted text-balance">{title}</p>
      {action}
    </div>
  )
}
