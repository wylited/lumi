import { Button, LiveDot } from '@heli/ui'
import { audio } from '../../lib/audio'

/** While a line is playing: what is being said, and a stop you can hit without looking. */
export function SpeechBar({ line }: { line: string }) {
  return (
    <div
      role="status"
      className="pointer-events-auto flex w-[440px] items-center gap-3 rounded-pill border border-border-strong/70 bg-bg py-1.5 pl-4 pr-1.5 shadow-md"
    >
      <LiveDot state="speaking" />
      <span className="min-w-0 flex-1 truncate text-small text-text">“{line}”</span>
      <Button size="sm" variant="secondary" onClick={() => audio.stop()}>
        Stop
      </Button>
    </div>
  )
}
