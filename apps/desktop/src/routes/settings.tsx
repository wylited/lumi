import { useCallback, useEffect, useState } from 'react'
import type { Signal } from '@heli/contracts'
import { Button } from '@heli/ui'
import { Switch } from '../components/goal/Controls'
import { NeverCapture } from '../components/settings/NeverCapture'
import { DeskPanel } from '../components/desk/DeskPanel'
import { PhonePairing } from '../components/phone/PhonePairing'
import { Preflight } from '../components/settings/Preflight'
import { Group, PageTitle, Row } from '../components/kit'
import { audio, useAudio } from '../lib/audio'
import { presenterOn, setPresenter } from '../lib/presenter'
import { native, useRecentSignals, type PermissionState } from '../lib/native'

const STATE: Record<PermissionState['state'], { label: string; className: string }> = {
  granted: { label: 'Allowed', className: 'text-accent-link' },
  missing: { label: 'Not allowed', className: 'text-warn' },
  unavailable: { label: 'Unavailable', className: 'text-text-faint' },
}

export function SettingsRoute() {
  const [perms, setPerms] = useState<PermissionState[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [showSignals, setShowSignals] = useState(false)
  const { muted } = useAudio()
  const [presenter, setPresenterState] = useState(presenterOn())
  useEffect(() => {
    const sync = () => setPresenterState(presenterOn())
    window.addEventListener('lumi:presenter', sync)
    return () => window.removeEventListener('lumi:presenter', sync)
  }, [])
  const signals = useRecentSignals()

  const check = useCallback(async () => setPerms(await native.permissions()), [])

  useEffect(() => {
    void check()
    void native.denylist().then(setDeny)
    // Coming back from System Settings is when a grant lands.
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [check])

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-8 px-10 pb-16 pt-2">
      <PageTitle>Settings</PageTitle>

      <Preflight />

      <DeskPanel />

      <PhonePairing />

      <Group
        title="Permissions"
        footer="Missing ones switch that signal off; nothing else changes. Input Monitoring applies after a restart."
      >
        {!native.available ? (
          <Row
            label="Only in the desktop app"
            detail="The browser preview has no native signals."
          />
        ) : (
          perms.map((p) => (
            <Row key={p.id} label={p.label} detail={p.usedFor}>
              <span className={`text-small ${STATE[p.state].className}`}>
                {STATE[p.state].label}
              </span>
              {p.state === 'missing' && p.pane ? (
                <Button variant="secondary" size="sm" onClick={() => void native.openPane(p.pane!)}>
                  Open
                </Button>
              ) : null}
            </Row>
          ))
        )}
      </Group>

      <Group title="Display">
        <Row label="Presenter mode" detail="Larger, higher contrast — for a projector. ⌘⇧P">
          <Switch label="Presenter mode" checked={presenter} onChange={(on) => setPresenter(on)} />
        </Row>
      </Group>

      <Group title="Voice">
        <Row label="Speak out loud" detail="When a nudge is ignored">
          <Switch label="Speak out loud" checked={!muted} onChange={(on) => audio.setMuted(!on)} />
        </Row>
      </Group>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-small font-medium text-text-muted">Never capture</h2>
        <NeverCapture
          ids={deny}
          onChange={(v) => {
            setDeny(v)
            void native.setDenylist(v)
          }}
        />
        <p className="px-1 text-caption text-text-faint">
          No screen frame is taken while one of these is in front. The lock screen is never
          captured.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setShowSignals((s) => !s)}
          aria-expanded={showSignals}
          className="self-start px-1 text-small font-medium text-text-muted hover:text-text"
        >
          {showSignals ? '▾' : '▸'} Signals sent ({signals.length})
        </button>
        {showSignals ? (
          <div className="max-h-[320px] overflow-y-auto rounded-md border border-border">
            {signals.length === 0 ? (
              <p className="px-4 py-3 text-small text-text-faint">None yet.</p>
            ) : (
              <ol className="divide-y divide-border">
                {signals.map((s, i) => (
                  <SignalRow key={`${s.ts}${i}`} s={s} />
                ))}
              </ol>
            )}
          </div>
        ) : null}
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
    <li className="grid grid-cols-[64px_110px_1fr] gap-3 px-4 py-2 text-small" data-selectable>
      <span className="tnum text-text-faint">{new Date(s.ts).toLocaleTimeString('en-GB')}</span>
      <span className="text-text">{s.kind}</span>
      <span className="truncate text-text-muted">{summary}</span>
    </li>
  )
}
