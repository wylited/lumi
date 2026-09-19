import { useState } from 'react'
import { useRecentSignals } from '../../lib/native'

/** The raw signals, collapsed: one click for the sceptic. */
export function Signals() {
  const [open, setOpen] = useState(false)
  const signals = useRecentSignals().slice(0, 20)
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="self-start text-small font-medium text-text-muted hover:text-text"
      >
        {open ? '▾' : '▸'} Raw signals
      </button>
      {open ? (
        <ol
          className="flex flex-col gap-0.5 rounded-md bg-surface px-4 py-3 font-mono text-[11.5px] text-text-muted"
          data-selectable
        >
          {signals.length === 0 ? (
            <li>None from this Mac yet — native signals exist only in the desktop app.</li>
          ) : null}
          {signals.map((s, i) => (
            <li key={`${s.ts}${i}`} className="truncate">
              <span className="text-text-faint">{new Date(s.ts).toLocaleTimeString('en-GB')}</span>{' '}
              {s.kind}{' '}
              {Object.entries(s.payload)
                .filter(([k]) => k !== 'pid')
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
