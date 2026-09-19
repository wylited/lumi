import { useEffect, useState } from 'react'
import type { DeskStatus, Signal } from '@heli/contracts'
import { Button, cn } from '@heli/ui'
import { FramePane } from '../desk/FramePane'
import { native, useRecentSignals, type PermissionState } from '../../lib/native'

function latest(signals: Signal[], kind: string) {
  return signals.find((s) => s.kind === kind)?.payload ?? null
}

/** The watch: every claim on this screen is live, or it says it is missing. */
export function WatchStep({
  sessionId,
  desk,
  onDone,
}: {
  sessionId: string | null
  desk: DeskStatus | null
  onDone: () => void
}) {
  const signals = useRecentSignals()
  const [perms, setPerms] = useState<PermissionState[]>([])

  useEffect(() => {
    const check = () => void native.permissions().then(setPerms)
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const app = latest(signals, 'app.frontmost') ?? latest(signals, 'app.heartbeat')
  const title = latest(signals, 'window.title')
  const input = latest(signals, 'input.rate')
  const idle = latest(signals, 'idle.state')
  const missing = perms.filter((p) => p.state === 'missing')
  const fps = desk?.health?.fps ?? null
  const pending = native.available ? '—' : 'desktop app only'

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-display-2 font-semibold tracking-tight text-text">
          This is what Lumi sees.
        </h1>
        <p className="text-body text-text-muted">All of it, live. Nothing here is a promise.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-small font-medium text-text">The desk</h2>
            <span className="tnum text-caption text-text-faint">
              {desk?.connected
                ? `${desk.desk?.camera?.model ?? 'camera'} · ${fps ?? 0} fps`
                : 'Lumi One not connected'}
            </span>
          </div>
          <FramePane
            sessionId={sessionId}
            source="camera"
            label="Camera"
            empty="No frame from Lumi One yet."
            className="aspect-[4/3]"
          />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-small font-medium text-text">The screen</h2>
            <span className="text-caption text-text-faint">
              one frame every 10 s, only while a session is live
            </span>
          </div>
          <FramePane
            sessionId={sessionId}
            source="screen"
            label="Screen"
            empty="No screen frame yet."
            everyMs={3000}
            className="aspect-[4/3]"
          />
        </section>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-small font-medium text-text">This Mac</h2>
        <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
          {[
            ['In front', app ? String(app.name) : pending],
            ['Window', title ? String(title.title) : pending],
            [
              'Typing',
              input
                ? `${String(input.events)} / 30 s`
                : native.available
                  ? 'needs Input Monitoring'
                  : pending,
            ],
            [
              'Idle',
              idle ? `${String(idle.state)} · ${Math.round(Number(idle.seconds))} s` : pending,
            ],
          ].map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col gap-0.5 bg-bg px-4 py-3">
              <span className="text-caption text-text-faint">{k}</span>
              <span className="truncate text-body text-text">{v}</span>
            </div>
          ))}
        </div>
        <ol
          className="flex flex-col gap-0.5 rounded-md bg-surface px-4 py-3 font-mono text-[11.5px] text-text-muted"
          aria-label="The last signals"
        >
          {signals.slice(0, 5).map((s, i) => (
            <li key={`${s.ts}${i}`} className="truncate">
              <span className="text-text-faint">{new Date(s.ts).toLocaleTimeString('en-GB')}</span>{' '}
              {s.kind}{' '}
              {Object.entries(s.payload)
                .filter(([k]) => k !== 'pid')
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')}
            </li>
          ))}
          {signals.length === 0 ? <li>Waiting for the first signal…</li> : null}
        </ol>
      </section>

      {perms.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-small font-medium text-text">What macOS allows</h2>
          <div className="divide-y divide-border rounded-md border border-border">
            {perms.map((p) => (
              <div key={p.id} className="flex items-center gap-4 px-4 py-3">
                <span
                  className={cn(
                    'size-2 rounded-pill',
                    p.state === 'granted'
                      ? 'bg-accent'
                      : p.state === 'missing'
                        ? 'bg-warn'
                        : 'bg-ink-300',
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body text-text">{p.label}</span>
                  <span className="text-small text-text-faint">{p.usedFor}</span>
                </div>
                {p.state === 'missing' && p.pane ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void native.openPane(p.pane!)}
                  >
                    Allow
                  </Button>
                ) : (
                  <span className="text-small text-text-faint">
                    {p.state === 'granted' ? 'Allowed' : 'Unavailable'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onDone}>{missing.length ? 'Continue anyway' : 'Continue'}</Button>
        {missing.length ? (
          <span className="text-small text-text-faint">
            Without {missing.map((m) => m.label).join(' and ')}, Lumi will not see{' '}
            {missing.map((m) => m.usedFor.replace(/\.$/, '').toLowerCase()).join('; ')}.
          </span>
        ) : null}
      </div>
    </div>
  )
}
