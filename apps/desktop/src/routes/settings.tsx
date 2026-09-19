import { useCallback, useEffect, useState } from 'react'
import type { Signal } from '@heli/contracts'
import { Button, Card, CardBody, EmptyState, Pill, type PillTone } from '@heli/ui'
import { Tokens } from '../components/goal/Controls'
import { native, useRecentSignals, type PermissionState } from '../lib/native'

const TONE: Record<PermissionState['state'], { tone: PillTone; label: string }> = {
  granted: { tone: 'accent', label: 'granted' },
  missing: { tone: 'warn', label: 'missing' },
  unavailable: { tone: 'neutral', label: 'not available' },
}

export function SettingsRoute() {
  const [perms, setPerms] = useState<PermissionState[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [deny, setDeny] = useState<string[]>([])
  const signals = useRecentSignals()

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setPerms(await native.permissions())
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
    void native.denylist().then(setDeny)
    // Coming back from System Settings is the moment a grant lands.
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [check])

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-10 px-8 py-8">
      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-title-2 font-semibold text-text">What it can see</h2>
            <p className="text-small text-text-muted">
              Each signal needs its own consent. A missing one is simply absent — the rest keep
              working.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void check()} loading={checking}>
            Re-check
          </Button>
        </div>

        {!native.available ? (
          <EmptyState title="Native signals only exist in the desktop app, not in a browser preview." />
        ) : (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
            {(perms ?? []).map((p) => (
              <div key={p.id} className="flex items-center gap-4 bg-surface-raised px-5 py-4">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2.5">
                    <span className="text-body-strong font-medium text-text">{p.label}</span>
                    <Pill tone={TONE[p.state].tone} dot>
                      {TONE[p.state].label}
                    </Pill>
                  </span>
                  <span className="text-small text-text-faint">{p.usedFor}</span>
                </div>
                {p.state === 'missing' && p.pane ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {p.id === 'screen' || p.id === 'input' ? (
                      <Button variant="ghost" size="sm" onClick={() => void native.request(p.id)}>
                        Ask macOS
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void native.openPane(p.pane!)}
                    >
                      Open System Settings
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <p className="text-caption text-text-faint">
          Input Monitoring takes effect the next time Helicopter starts. Keystrokes are counted,
          never recorded.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-title-2 font-semibold text-text">Never capture</h2>
          <p className="text-small text-text-muted">
            No screen frame is taken while one of these apps is in front. Bundle identifiers.
          </p>
        </div>
        <Tokens
          tone="block"
          values={deny}
          placeholder="com.example.app"
          onChange={(v) => {
            setDeny(v)
            void native.setDenylist(v)
          }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-title-2 font-semibold text-text">Signals, as they leave</h2>
          <span className="text-caption text-text-faint">the last {signals.length}</span>
        </div>
        <Card>
          <CardBody className="max-h-[360px] overflow-y-auto p-0">
            {signals.length === 0 ? (
              <p className="p-5 text-small text-text-faint">
                Nothing yet. Switch apps or type for a few seconds.
              </p>
            ) : (
              <ol className="flex flex-col divide-y divide-border">
                {signals.map((s, i) => (
                  <SignalRow key={`${s.ts}${i}`} s={s} />
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </section>
    </div>
  )
}

function SignalRow({ s }: { s: Signal }) {
  const summary = Object.entries(s.payload)
    .filter(([k]) => k !== 'pid')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' · ')
  return (
    <li className="flex items-baseline gap-3 px-5 py-2.5" data-selectable>
      <span className="tnum w-16 shrink-0 font-mono text-[11px] text-text-faint">
        {new Date(s.ts).toLocaleTimeString('en-GB')}
      </span>
      <span className="w-28 shrink-0 font-mono text-[11px] text-accent-link">{s.kind}</span>
      <span className="min-w-0 truncate text-caption text-text-muted">{summary}</span>
      {s.confidence < 1 ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">
          {s.confidence}
        </span>
      ) : null}
    </li>
  )
}
