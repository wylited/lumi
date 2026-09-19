import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent-strong text-accent-contrast hover:bg-accent-strong-hover',
  secondary:
    'border border-border-strong text-text hover:border-accent hover:text-accent-link hover:bg-accent-wash',
  ghost: 'text-text-muted hover:text-text hover:bg-surface',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3.5 text-small',
  md: 'h-10 gap-2 px-5 text-body-strong',
  lg: 'h-12 gap-2.5 px-6 text-body-strong',
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('size-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leading,
  trailing,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center rounded-pill font-ui font-medium whitespace-nowrap',
        'transition-colors duration-base ease-sifu outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Spinner /> : leading}
      {children}
      {!loading && trailing}
    </button>
  )
}
