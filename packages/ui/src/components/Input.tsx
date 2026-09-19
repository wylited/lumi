import type { InputHTMLAttributes, ReactNode } from 'react'
import { useId } from 'react'
import { cn } from '../cn'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string
  hint?: string
  error?: string
  prefix?: ReactNode
  suffix?: ReactNode
}

export function Input({
  label,
  hint,
  error,
  prefix,
  suffix,
  className,
  id,
  ...props
}: InputProps) {
  const generated = useId()
  const inputId = id ?? generated
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-small font-medium text-text">
          {label}
        </label>
      ) : null}
      <div
        className={cn(
          'flex h-10 items-center gap-2 rounded-pill border bg-bg px-4',
          'transition-colors duration-base ease-sifu',
          'focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-bg',
          error
            ? 'border-danger focus-within:ring-danger'
            : 'border-border-strong focus-within:border-accent focus-within:ring-accent',
          props.disabled && 'opacity-45',
        )}
      >
        {prefix ? <span className="text-text-faint">{prefix}</span> : null}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-body-strong text-text outline-none',
            'placeholder:text-text-faint disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        />
        {suffix ? <span className="text-text-faint">{suffix}</span> : null}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-small text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-small text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
