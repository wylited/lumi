import { useCallback, useEffect, useState } from 'react'
import { DeskStatus, type Goal } from '@heli/contracts'
import { Mark } from '../components/shell/Mark'
import { DeskStep } from '../components/setup/DeskStep'
import { GoalStep } from '../components/setup/GoalStep'
import { PhoneStep } from '../components/setup/PhoneStep'
import { Steps } from '../components/setup/Steps'
import { WatchStep } from '../components/setup/WatchStep'
import { api } from '../lib/api'
import { loadGoal } from '../lib/goals'
import { live } from '../lib/live'
import { logger } from '../lib/log'
import { markSetupDone, openSession } from '../lib/setup'

const log = logger('setup')

/** First run: the goal, the watch, the desk, the phone — then Live. No code, no pairing, one person. */
export function SetupRoute({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0)
  const [existing, setExisting] = useState<Goal | null>(null)
  const [desk, setDesk] = useState<DeskStatus | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const refreshDesk = useCallback(async () => {
    const parsed = DeskStatus.safeParse(await api.desk())
    setDesk(parsed.success ? parsed.data : null)
  }, [])

  useEffect(() => {
    void loadGoal().then(setExisting)
    void refreshDesk()
    const t = setInterval(() => void refreshDesk(), 3000)
    return () => clearInterval(t)
  }, [refreshDesk])

  async function goalSaved(goal: Goal) {
    setExisting(goal)
    setStep(1)
    // The watch step proves the camera live, and frames only attach to an open session.
    // Sessions still reference a Device row (not a desk) on the server, so the machine's device is used.
    try {
      const deviceId = (await api.devices())[0]?.id
      if (deviceId) setSessionId(await openSession(deviceId, goal.id))
    } catch (e) {
      log.warn('could not open a session for the preview', String(e))
    }
  }

  async function start() {
    setStarting(true)
    markSetupDone()
    await live.attach()
    setStarting(false)
    onFinish()
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end px-6">
        <Mark className="size-5" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[980px] flex-col gap-10 px-10 pb-16 pt-4">
          <Steps at={step} />
          {step === 0 ? <GoalStep existing={existing} onDone={(g) => void goalSaved(g)} /> : null}
          {step === 1 ? (
            <WatchStep sessionId={sessionId} desk={desk} onDone={() => setStep(2)} />
          ) : null}
          {step === 2 ? (
            <DeskStep
              sessionId={sessionId}
              desk={desk}
              starting={starting}
              onDone={() => setStep(3)}
            />
          ) : null}
          {step === 3 ? (
            <PhoneStep onDone={() => void start()} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
