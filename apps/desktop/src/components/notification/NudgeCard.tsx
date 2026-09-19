import { useEffect } from 'react'
import { Button } from '@heli/ui'
import { notify, type Nudge } from '../../lib/notify'
import { Mark } from '../shell/Mark'

const TIMEOUT_MS = 45_000

/** The nudge with its two actions. It leaves on its own after a while — a nudge, not a nag. */
export function NudgeCard({ nudge }: { nudge: Nudge }) {
  useEffect(() => {
    const t = setTimeout(() => notify.dismiss(), TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [nudge.id])

  return (
    <div
      role="alertdialog"
      aria-label="Nudge"
      className="pointer-events-auto w-[320px] rounded-md border border-border-strong/70 bg-bg p-3.5 shadow-md"
    >
      <div className="flex items-start gap-3">
        <Mark className="size-6 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-caption text-text-faint">Lumi</span>
          <p className="text-small text-text">{nudge.message}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button size="sm" onClick={() => notify.backToGoal()}>
          Back to the goal
        </Button>
        <Button size="sm" variant="secondary" onClick={() => notify.snooze()}>
          Snooze 10m
        </Button>
      </div>
    </div>
  )
}
