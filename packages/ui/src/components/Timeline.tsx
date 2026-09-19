import type { ReactNode } from 'react'
import { cn } from '../cn'

export interface TimelineMoment {
  id: string
  ts: string
  silent?: boolean
  tone?: 'accent' | 'danger' | 'warn' | 'neutral'
  title?: string
  meta?: ReactNode
  children?: ReactNode
}

export interface TimelineProps {
  moments: TimelineMoment[]
  className?: string
}

const tickTones = {
  accent: 'bg-accent',
  danger: 'bg-danger',
  warn: 'bg-warn',
  neutral: 'bg-ink-300',
} as const

/**
 * The session view. Silent moments collapse to a 2px tick on the rail —
 * that shape is the whole argument that this is not a chatbot.
 */
export function Timeline({ moments, className }: TimelineProps) {
  return (
    <ol className={cn('relative flex flex-col', className)}>
      <span
        aria-hidden="true"
        className="absolute left-[3px] top-1 bottom-1 w-px bg-border"
      />
      {moments.map((moment) => (
        <li key={moment.id} className="relative pl-6">
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-0 top-[7px] h-0.5 w-2 rounded-pill',
              tickTones[moment.tone ?? 'accent'],
            )}
          />
          {moment.silent ? (
            <div className="py-1.5 font-mono text-[11px] text-text-faint">
              {moment.ts}
              <span className="sr-only"> — silent, check passed</span>
            </div>
          ) : (
            <div className="pb-5">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-text-faint">{moment.ts}</span>
                {moment.title ? (
                  <span className="text-small font-medium text-text">{moment.title}</span>
                ) : null}
                {moment.meta}
              </div>
              {moment.children ? <div className="mt-2.5">{moment.children}</div> : null}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}
