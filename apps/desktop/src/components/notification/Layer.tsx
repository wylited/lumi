import { useEffect } from 'react'
import { useAudio } from '../../lib/audio'
import { block, useBlocked } from '../../lib/block'
import { notify, useNotify } from '../../lib/notify'
import { BlockedCard } from './BlockedCard'
import { NudgeCard } from './NudgeCard'
import { SpeechBar } from './SpeechBar'

/** The in-app interruption surfaces, over whatever route is open. Wires itself to the live store. */
export function NotificationLayer() {
  const { nudge } = useNotify()
  const { speaking } = useAudio()
  const blocked = useBlocked()

  useEffect(() => notify.attach(), [])
  useEffect(() => block.attach(), [])

  return (
    // Bottom-right, out of the way of the numbers you are reading; never takes focus.
    <div className="pointer-events-none fixed inset-0 z-40 flex flex-col items-end justify-end gap-2 p-5">
      {blocked ? <BlockedCard blocked={blocked} /> : null}
      {nudge ? <NudgeCard nudge={nudge} /> : null}
      {speaking ? <SpeechBar line={speaking} /> : null}
    </div>
  )
}
