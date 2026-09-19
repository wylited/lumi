import { useEffect, useState } from 'react'
import type { DeskStatus } from '@heli/contracts'
import { Button, Input } from '@heli/ui'
import { AimOverlay } from '../desk/AimOverlay'
import { FramePane } from '../desk/FramePane'
import { Group, Row } from '../kit'
import { api } from '../../lib/api'
import { aimAt, rigCalibration, savedRegion, type Calibration, type Region } from '../../lib/setup'

export function DeskStep({
  sessionId,
  desk,
  onDone,
  starting,
}: {
  sessionId: string | null
  desk: DeskStatus | null
  onDone: () => void
  starting: boolean
}) {
  const d = desk?.desk ?? null
  const [name, setName] = useState(d?.name ?? 'Desk')
  const [region, setRegion] = useState<Region | null>(savedRegion())
  const [cal, setCal] = useState<Calibration | null>(null)
  const [aim, setAim] = useState<{ ok: boolean; text: string } | null>(null)
  const [aiming, setAiming] = useState(false)

  useEffect(() => {
    void rigCalibration().then(setCal)
  }, [])
  useEffect(() => {
    if (d?.name) setName(d.name)
  }, [d?.name])

  async function saveName() {
    if (!d || name.trim() === d.name) return
    await api
      .renameDesk({ deskId: d.id, name: name.trim(), camera: d.camera, arm: d.arm })
      .catch(() => null)
  }

  async function aimHere() {
    if (!d || !region || !cal) return
    setAiming(true)
    try {
      const rec = await aimAt(d.id, region, cal)
      if (!rec) setAim({ ok: false, text: 'No server — nothing was sent.' })
      else if (rec.status === 'failed')
        setAim({ ok: false, text: `The rig refused: ${rec.error ?? 'no reason given'}.` })
      else {
        const pose = rec.result?.pose
        setAim({
          ok: true,
          text: pose
            ? `Aimed — pan ${pose.pan.toFixed(1)}°, tilt ${pose.tilt.toFixed(1)}°.`
            : 'Sent to the arm.',
        })
      }
    } catch (e) {
      setAim({ ok: false, text: e instanceof Error ? e.message : 'Could not aim.' })
    } finally {
      setAiming(false)
    }
  }

  const canAim = !!d?.arm && !!cal?.rectMm && (cal?.poses ?? 0) >= 3

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-display-2 font-semibold tracking-tight text-text">
          Point it at your desk.
        </h1>
        <p className="text-body text-text-muted">
          Drag over the part of the desk to watch. The arm aims at its centre.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <FramePane
          sessionId={sessionId}
          source="camera"
          label="Camera"
          empty="No frame from Lumi One yet."
          className="aspect-[4/3]"
        >
          <AimOverlay
            value={region}
            onChange={(r) => {
              setRegion(r)
              setAim(null)
            }}
          />
        </FramePane>

        <div className="flex flex-col gap-4">
          <Group>
            <Row label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void saveName()}
                aria-label="Desk name"
                className="w-40"
                disabled={!d}
              />
            </Row>
            <Row
              label="Camera"
              detail={d?.camera ? `${d.camera.maxWidth}×${d.camera.maxHeight}` : undefined}
            >
              <span className="text-body text-text-muted">
                {d?.camera?.model ?? 'none reported'}
              </span>
            </Row>
            <Row label="Arm" detail={d?.arm ? `${d.arm.dof} axes` : undefined}>
              <span className="text-body text-text-muted">
                {d?.arm?.model ?? 'no arm — the camera stays fixed'}
              </span>
            </Row>
            <Row label="Lumi One">
              <span
                className={desk?.connected ? 'text-body text-accent-link' : 'text-body text-warn'}
              >
                {desk?.connected ? 'Connected' : d ? 'Not connected' : 'Not set up'}
              </span>
            </Row>
          </Group>

          {d?.arm ? (
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => void aimHere()}
                loading={aiming}
                disabled={!region || !canAim}
                variant="secondary"
              >
                Aim here
              </Button>
              {!canAim && cal !== null ? (
                <p className="text-small text-text-faint">
                  The arm needs a calibration first. On this Mac, run{' '}
                  <code className="rounded-[4px] bg-surface px-1 font-mono text-[12px]">
                    uv run heli-rig --calibrate --rect 0,0,300,220
                  </code>
                  .
                </p>
              ) : null}
              {aim ? (
                <p
                  role="status"
                  className={aim.ok ? 'text-small text-accent-link' : 'text-small text-warn'}
                >
                  {aim.text}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={onDone} loading={starting}>
          Start watching
        </Button>
        {!d ? (
          <span className="text-small text-text-faint">
            You can start without Lumi One; the desktop app works on its own.
          </span>
        ) : null}
      </div>
    </div>
  )
}
