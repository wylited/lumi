import { useState, type KeyboardEvent } from 'react'
import { cn } from '@heli/ui'

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
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm bg-ink-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[7px] px-3 py-1 text-small outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent',
            o.value === value
              ? 'bg-bg font-medium text-text shadow-sm'
              : 'text-text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-pill outline-none transition-colors duration-base focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
        checked ? 'bg-accent-strong' : 'bg-ink-200',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] size-[18px] rounded-pill bg-bg shadow-sm transition-transform duration-base ease-heli',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

export function Stepper({
  value,
  onChange,
  step = 5,
  min = 0,
  max = 480,
  unit,
  label,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  unit: string
  label: string
}) {
  const btn =
    'grid size-7 place-items-center rounded-[7px] text-body text-text-muted outline-none hover:bg-ink-100 hover:text-text focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30'
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
        aria-label={`Less ${label}`}
      >
        −
      </button>
      <span className="tnum w-20 text-center text-body text-text">
        {value ? `${value} ${unit}` : 'None'}
      </span>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
        aria-label={`More ${label}`}
      >
        +
      </button>
    </div>
  )
}

/** Short strings as chips, inline in a row. Enter or comma adds; backspace on empty removes the last. */
export function Tokens({
  values,
  onChange,
  placeholder,
  label,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder: string
  label: string
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
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-0.5 rounded-[6px] bg-ink-100 py-0.5 pl-2 pr-0.5 text-small text-text"
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="grid size-5 place-items-center rounded-[5px] text-text-faint hover:bg-ink-200 hover:text-text"
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => text && add(text)}
        placeholder={placeholder}
        className="w-24 bg-transparent px-1 py-0.5 text-right text-small text-text outline-none placeholder:text-text-faint focus:w-40"
      />
    </div>
  )
}
