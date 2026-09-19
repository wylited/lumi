import type { SelectHTMLAttributes } from 'react'
import { useId } from 'react'
import { cn } from '../cn'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: string
  error?: string
}

export function Select({ label, hint, error, className, id, children, ...props }: SelectProps) {
  const generated = useId()
  const selectId = id ?? generated
  const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={selectId} className="text-small font-medium text-text">
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          'relative flex h-10 items-center rounded-pill border bg-bg pl-4 pr-9',
          'transition-colors duration-base ease-sifu',
          'focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-bg',
          error
            ? 'border-danger focus-within:ring-danger'
            : 'border-border-strong focus-within:border-accent focus-within:ring-accent',
        )}
      >
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full appearance-none bg-transparent text-body-strong text-text outline-none',
            '[&>option]:bg-bg [&>option]:text-text',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <svg
          className="pointer-events-none absolute right-4 size-3 text-text-faint"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      {error ? (
        <p id={`${selectId}-error`} className="text-small text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${selectId}-hint`} className="text-small text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
