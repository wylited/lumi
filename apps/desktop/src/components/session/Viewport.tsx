import { FramePane } from '../desk/FramePane'

/** The two things it looks at, side by side: the desk camera and the screen. */
export function Viewport({ sessionId, demo }: { sessionId: string | null; demo: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FramePane
        sessionId={demo ? null : sessionId}
        source="camera"
        label="Desk"
        empty="No frame from Lumi One yet."
        idle={demo ? 'The demo has no camera. Lumi One’s frames appear here.' : undefined}
        className="aspect-[16/10]"
      />
      <FramePane
        sessionId={demo ? null : sessionId}
        source="screen"
        label="Screen"
        everyMs={3000}
        empty="No screen frame yet — Screen Recording may be off."
        idle={demo ? 'The demo has no screen frames.' : undefined}
        className="aspect-[16/10]"
      />
    </div>
  )
}
