import { useEffect } from 'react'
import { useAudio } from '../../lib/audio'
import { notify, useNotify } from '../../lib/notify'
import { NudgeCard } from './NudgeCard'
import { SpeechBar } from './SpeechBar'

/** The in-app interruption surfaces, over whatever route is open. Wires itself to the live store. */
export function NotificationLayer() {
  const { nudge } = useNotify()
  const { speaking } = useAudio()

  useEffect(() => notify.attach(), [])

  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex flex-col items-end justify-between p-5 pt-[68px]">
      <div>{nudge ? <NudgeCard nudge={nudge} /> : null}</div>
      <div className="self-center">{speaking ? <SpeechBar line={speaking} /> : null}</div>
    </div>
  )
}
