import { useEffect, useState } from 'react'
import { Button } from '@heli/ui'
import { block, type Blocked } from '../../lib/block'
import { Mark } from '../shell/Mark'

const TIMEOUT_MS = 45_000

/** What was just blocked, and the one-click way back. Leaves on its own; the block stays. */
export function BlockedCard({ blocked }: { blocked: Blocked }) {
  const [undoing, setUndoing] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => block.dismiss(), TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [blocked.id])

  return (
    <div
      role="status"
      aria-label="Blocked"
      className="pointer-events-auto w-[320px] rounded-md border border-border-strong/70 bg-bg p-3.5 shadow-md"
    >
      <div className="flex items-start gap-3">
        <Mark className="size-6 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-caption text-text-faint">
            {blocked.why === 'goal' ? 'On your goal’s list' : 'Lumi judged it off the goal'}
          </span>
          <p className="text-small text-text">
            {blocked.kind === 'app' ? `Hid ${blocked.target}.` : `Moved a tab off ${blocked.target}.`}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={undoing}
          onClick={() => {
            setUndoing(true)
            void blocked.undo().finally(() => setUndoing(false))
          }}
        >
          Undo for 10 min
        </Button>
        <Button size="sm" variant="ghost" onClick={() => block.dismiss()}>
          Keep it
        </Button>
      </div>
    </div>
  )
}
