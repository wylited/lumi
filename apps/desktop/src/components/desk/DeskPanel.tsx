import { useEffect, useState } from 'react'
import { DeskStatus } from '@heli/contracts'
import { Button } from '@heli/ui'
import { Group, Row } from '../kit'
import { Switch } from '../goal/Controls'
import { FramePane } from './FramePane'
import { api } from '../../lib/api'

function ago(iso: string | null) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 2 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** What each refusal from the rig means, in words the person can act on. */
const TRACK_ERRORS: Record<string, string> = {
  tracking_disabled: 'Following is off on this rig. Set HELI_TRACKING=auto for it and restart it.',
  tracking_unavailable: 'The rig has no arm or no pose model to follow with.',
  desk_offline: 'Lumi One is not connected.',
}

/** Lumi One in Settings: what the server knows about the desk, refreshed every few seconds. */
export function DeskPanel() {
  const [desk, setDesk] = useState<DeskStatus | null | undefined>(undefined)
  // The last answer to `arm.track`, until the rig reports `following` in its health.
  const [acked, setAcked] = useState<boolean | null>(null)
  const [switching, setSwitching] = useState(false)
  const [trackError, setTrackError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const parsed = DeskStatus.safeParse(await api.desk())
      setDesk(parsed.success ? parsed.data : null)
    }
    void load()
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [])

  const d = desk?.desk ?? null
  const h = desk?.health ?? null
  const following = h?.following ?? acked ?? false

  async function follow(on: boolean) {
    if (!d) return
    setSwitching(true)
    setTrackError(null)
    try {
      const res = await api.deskAction(d.id, { type: 'arm.track', payload: { on } })
      if (res?.status === 'done') setAcked(on)
      else setTrackError(TRACK_ERRORS[res?.error ?? ''] ?? `The rig did not follow: ${res?.error ?? 'no answer'}.`)
    } catch (e) {
      setTrackError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
    }
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-small font-medium text-text-muted">Lumi One</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => window.dispatchEvent(new Event('lumi:setup'))}
        >
          Run setup again
        </Button>
      </div>
      {desk === undefined ? null : !d ? (
        <Group>
          <Row
            label="No desk yet"
            detail={
              desk === null
                ? 'The server is not reachable.'
                : 'Lumi One registers itself the first time it runs on this Mac.'
            }
          />
        </Group>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
          <FramePane
            sessionId={desk?.session?.id ?? null}
            source="camera"
            label="Camera"
            empty="No frame yet."
            className="aspect-[4/3]"
          />
          <Group>
            <Row label={d.name}>
              <span
                className={desk?.connected ? 'text-small text-accent-link' : 'text-small text-warn'}
              >
                {desk?.connected ? 'Connected' : 'Disconnected'}
              </span>
            </Row>
            <Row label="Camera">
              <span className="text-small text-text-muted">{d.camera?.model ?? 'none'}</span>
            </Row>
            <Row label="Arm">
              <span className="tnum text-small text-text-muted">
                {!d.arm
                  ? 'none'
                  : !desk?.connected
                    ? 'disconnected'
                    : h?.armPose
                      ? `pan ${h.armPose.pan.toFixed(0)}° · tilt ${h.armPose.tilt.toFixed(0)}°`
                      : d.arm.model}
              </span>
            </Row>
            {d.arm ? (
              <Row
                label="Follow me"
                detail={trackError ?? 'The arm keeps you in frame as you move.'}
              >
                <Switch
                  label="Follow me"
                  checked={following}
                  onChange={(on) => void (switching ? null : follow(on))}
                />
              </Row>
            ) : null}
            <Row label="Capture">
              <span className="tnum text-small text-text-muted">
                {h ? `${h.fps} fps · last frame ${ago(h.lastFrameAt)}` : '—'}
              </span>
            </Row>
          </Group>
        </div>
      )}
    </section>
  )
}
