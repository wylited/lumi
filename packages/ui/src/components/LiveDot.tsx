import { cn } from '../cn'

export type LiveState = 'idle' | 'live' | 'speaking'

export interface LiveDotProps {
  state?: LiveState
  className?: string
}

const labels: Record<LiveState, string> = {
  idle: 'Idle',
  live: 'Live',
  speaking: 'Speaking',
}

export function LiveDot({ state = 'idle', className }: LiveDotProps) {
  return (
    <span
      role="status"
      aria-label={labels[state]}
      className={cn('relative inline-flex size-2.5 shrink-0', className)}
    >
      {state === 'speaking' ? (
        <span className="absolute inset-0 rounded-pill bg-accent ring-speak" aria-hidden="true" />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          'relative size-2.5 rounded-pill',
          state === 'idle' ? 'bg-ink-300' : 'bg-accent',
          state === 'live' && 'pulse-live',
        )}
      />
    </span>
  )
}
