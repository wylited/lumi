import { useState } from 'react'
import type { DeskStatus } from '@heli/contracts'
import { Button } from '@heli/ui'
import { FramePane } from '../desk/FramePane'
import { Consent } from './Consent'

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
  const [missing, setMissing] = useState<string[]>([])
  const fps = desk?.health?.fps ?? null

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
        <h2 className="px-1 text-small font-medium text-text">This Mac, live</h2>
        <Consent onMissing={setMissing} />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onDone}>{missing.length ? 'Continue anyway' : 'Continue'}</Button>
        {missing.length ? (
          <span className="text-small text-text-faint">
            Without those grants, Lumi will not see: {missing.join(', ')}.
          </span>
        ) : null}
      </div>
    </div>
  )
}
