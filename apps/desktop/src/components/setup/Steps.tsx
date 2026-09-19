import { cn } from '@heli/ui'

const STEPS = ['The goal', 'The watch', 'The desk', 'The phone'] as const

export function Steps({ at }: { at: 0 | 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-3" aria-label="Setup progress">
      {STEPS.map((s, i) => (
        <li
          key={s}
          className="flex items-center gap-3"
          aria-current={i === at ? 'step' : undefined}
        >
          <span
            className={cn(
              'tnum grid size-6 place-items-center rounded-pill text-caption font-semibold',
              i < at
                ? 'bg-accent-strong text-accent-contrast'
                : i === at
                  ? 'bg-text text-bg'
                  : 'bg-ink-100 text-text-faint',
            )}
          >
            {i < at ? '✓' : i + 1}
          </span>
          <span
            className={cn('text-small', i === at ? 'font-medium text-text' : 'text-text-faint')}
          >
            {s}
          </span>
          {i < STEPS.length - 1 ? <span className="h-px w-8 bg-border" aria-hidden="true" /> : null}
        </li>
      ))}
    </ol>
  )
}
