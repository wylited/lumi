import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@heli/ui'

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-small font-medium text-text">{label}</span>
        {hint ? <span className="text-caption text-text-faint">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-pill border border-border bg-surface p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-pill px-3.5 py-1.5 text-small font-medium outline-none transition-colors duration-fast',
            'focus-visible:ring-2 focus-visible:ring-accent',
            o.value === value
              ? 'bg-surface-raised text-text shadow-sm'
              : 'text-text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  detail: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3.5 rounded-md border border-border bg-surface-raised p-4 transition-colors duration-fast hover:border-border-strong">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-pill transition-colors duration-base peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
          checked ? 'bg-accent-strong' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-pill bg-bg shadow-sm transition-transform duration-base ease-heli',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-small font-medium text-text">{label}</span>
        <span className="text-caption text-text-faint">{detail}</span>
      </span>
    </label>
  )
}

/** A list of short strings as chips. Enter or comma adds, backspace on empty removes the last. */
export function Tokens({
  values,
  onChange,
  placeholder,
  tone,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder: string
  tone: 'allow' | 'block'
}) {
  const [text, setText] = useState('')
  function add(raw: string) {
    const v = raw
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
    if (v && !values.includes(v)) onChange([...values, v])
    setText('')
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
  }
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-bg px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-bg">
      {values.map((v) => (
        <span
          key={v}
          className={cn(
            'inline-flex items-center gap-1 rounded-xs py-1 pl-2 pr-1 font-mono text-[11.5px]',
            tone === 'allow' ? 'bg-accent-wash text-accent-link' : 'bg-warn-wash text-text',
          )}
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="grid size-4 place-items-center rounded-[3px] opacity-60 hover:bg-bg/50 hover:opacity-100"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => text && add(text)}
        placeholder={values.length ? '' : placeholder}
        className="min-w-[120px] flex-1 bg-transparent px-1.5 text-small text-text outline-none placeholder:text-text-faint"
      />
    </div>
  )
}
