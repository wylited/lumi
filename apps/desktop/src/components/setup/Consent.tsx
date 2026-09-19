import { useEffect, useState } from 'react'
import type { Signal } from '@heli/contracts'
import { Button, cn } from '@heli/ui'
import { native, useRecentSignals, type PermissionState } from '../../lib/native'

type Grant = PermissionState['id'] | null

/**
 * One row per signal a module actually emits, with its live value and the grant it needs. Nothing
 * is listed that the code does not read, and nothing the code reads is missing from the list.
 */
const ROWS: Array<{
  kind: string
  name: string
  grant: Grant
  value: (p: Signal['payload']) => string
}> = [
  { kind: 'app.frontmost', name: 'App in front', grant: null, value: (p) => String(p.name) },
  { kind: 'window.title', name: 'Window title', grant: 'screen', value: (p) => String(p.title) },
  {
    kind: 'screen.frame',
    name: 'Screen frame, every 10 s at most',
    grant: 'screen',
    value: (p) => `${Math.round(Number(p.bytes) / 1024)} KB · ${String(p.app)}`,
  },
  {
    kind: 'input.rate',
    name: 'Typing and clicks, counted',
    grant: 'input',
    value: (p) => `${String(p.events)} in 30 s · ${String(p.activity)}`,
  },
  {
    kind: 'idle.state',
    name: 'Idle',
    grant: null,
    value: (p) => `${String(p.state)} · ${Math.round(Number(p.seconds))} s`,
  },
  {
    kind: 'focus.element',
    name: 'Focused element — role and label only',
    grant: 'accessibility',
    value: (p) => [p.role, p.title].filter(Boolean).join(', '),
  },
]

export function Consent({ onMissing }: { onMissing?: (names: string[]) => void }) {
  const signals = useRecentSignals()
  const [perms, setPerms] = useState<PermissionState[]>([])

  const refresh = () => void native.permissions().then(setPerms)

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  /**
   * macOS only lists an app in Screen Recording or Input Monitoring **after the
   * app has asked**. Opening the pane without asking shows an empty room — which
   * is exactly what it showed before this called `request`. So: fire the system
   * prompt first, and only fall back to the pane when the prompt does not come
   * (it never comes twice, so a previously denied grant is resolved there).
   */
  async function allow(grant: Exclude<Grant, null>, pane: string): Promise<void> {
    const granted = await native.request(grant).catch(() => false)
    if (granted) {
      refresh()
      return
    }
    setTimeout(() => {
      void native.openPane(pane)
      refresh()
    }, 1_200)
  }

  const state = (g: Grant) =>
    g === null ? 'granted' : (perms.find((p) => p.id === g)?.state ?? 'missing')
  const pane = (g: Grant) => perms.find((p) => p.id === g)?.pane ?? null
  const label = (g: Grant) => perms.find((p) => p.id === g)?.label ?? ''

  const missing = ROWS.filter((r) => state(r.grant) === 'missing').map((r) =>
    r.name.split(' —')[0]!.split(',')[0]!.toLowerCase(),
  )
  useEffect(() => onMissing?.(missing), [missing.join('|')])

  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {ROWS.map((r) => {
        const latest = signals.find((s) => s.kind === r.kind)
        const st = native.available ? state(r.grant) : 'missing'
        return (
          <div
            key={r.kind}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-4 px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-pill',
                  st === 'granted' ? 'bg-accent' : 'bg-warn',
                )}
              />
              <span className="truncate text-body text-text">{r.name}</span>
            </div>
            <span className="truncate font-mono text-[12px] text-text-muted" data-selectable>
              {!native.available
                ? 'desktop app only'
                : latest
                  ? r.value(latest.payload)
                  : st === 'granted'
                    ? 'waiting…'
                    : '—'}
            </span>
            <span className="flex items-center justify-end gap-2 text-small text-text-faint">
              {r.grant === null ? 'no permission' : st === 'granted' ? label(r.grant) : null}
              {native.available && st === 'missing' && pane(r.grant) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void allow(r.grant!, pane(r.grant)!)}
                >
                  Allow {label(r.grant)}
                </Button>
              ) : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}
