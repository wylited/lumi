import { useState, type FormEvent } from 'react'

/** Bundle ids people will recognise, so the list reads as apps rather than identifiers. */
const KNOWN: Record<string, string> = {
  'com.1password.1password': '1Password',
  'com.agilebits.onepassword7': '1Password 7',
  'com.bitwarden.desktop': 'Bitwarden',
  'com.lastpass.LastPass': 'LastPass',
  'com.dashlane.dashlanephonefinal': 'Dashlane',
  'com.apple.keychainaccess': 'Keychain Access',
  'com.apple.Passwords': 'Passwords',
  'com.revolut.macos': 'Revolut',
  'com.paypal.PayPal': 'PayPal',
}

function nameOf(id: string) {
  return KNOWN[id] ?? id.split('.').pop() ?? id
}

/** The apps a screen frame is never taken of, as a list you can read, remove from, and add to. */
export function NeverCapture({
  ids,
  onChange,
}: {
  ids: string[]
  onChange: (ids: string[]) => void
}) {
  const [text, setText] = useState('')

  function add(e: FormEvent) {
    e.preventDefault()
    const id = text.trim()
    if (id && !ids.includes(id)) onChange([...ids, id])
    setText('')
  }

  return (
    <div className="divide-y divide-border rounded-md border border-border bg-bg">
      {ids.map((id) => (
        <div key={id} className="flex min-h-12 items-center gap-4 px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-body text-text">{nameOf(id)}</span>
            <span className="truncate text-caption text-text-faint">{id}</span>
          </div>
          <button
            type="button"
            onClick={() => onChange(ids.filter((x) => x !== id))}
            className="rounded-[7px] px-2.5 py-1 text-small text-text-muted outline-none hover:bg-ink-100 hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
          >
            Remove
          </button>
        </div>
      ))}
      <form onSubmit={add} className="flex min-h-12 items-center gap-3 px-4 py-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add an app by bundle id — com.example.app"
          aria-label="Add an app by bundle id"
          className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-faint"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="rounded-[7px] px-2.5 py-1 text-small font-medium text-accent-link outline-none hover:bg-accent-wash focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </div>
  )
}
