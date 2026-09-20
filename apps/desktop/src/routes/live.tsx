import { useEffect, useState } from 'react'
import type { Goal } from '@heli/contracts'
import { Button } from '@heli/ui'
import { SectionTitle } from '../components/kit'
import { Actions } from '../components/session/Actions'
import { Attention } from '../components/session/Attention'
import { Phone } from '../components/session/Phone'
import { Ribbon, RibbonLegend } from '../components/session/Ribbon'
import { Signals } from '../components/session/Signals'
import { Thinking } from '../components/session/Thinking'
import { Viewport } from '../components/session/Viewport'
import { desk } from '../lib/desk'
import { loadGoal } from '../lib/goals'
import { derive, live, settledOutcome, useLive } from '../lib/live'

function breakMarks(goal: Goal | null, total: number): number[] {
  const every =
    goal?.breakPolicy === 'pomodoro_25_5' ? 30 : goal?.breakPolicy === 'pomodoro_50_10' ? 60 : 0
  const work = every === 30 ? 25 : every === 60 ? 50 : 0
  if (!every) return []
  const out: number[] = []
  for (let m = work; m < total; m += every) out.push(m)
  return out
}

/** m:ss since the session started, ticking every second. */
function useClock(startedAt: string | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return null
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function LiveRoute() {
  const snap = useLive()
  const d = derive(snap)
  const [looking, setLooking] = useState(false)
  const [goal, setGoal] = useState<Goal | null>(null)
  const [frames, setFrames] = useState(0)
  const [starting, setStarting] = useState(false)
  const [ending, setEnding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clock = useClock(snap.session?.startedAt ?? null)

  useEffect(() => {
    void loadGoal().then(setGoal)
  }, [])

  useEffect(() => {
    if (live.get().status !== 'idle') return
    setLooking(true)
    void live.attach().finally(() => setLooking(false))
  }, [])

  // Frames read, from the desk status the rest of the app already polls.
  useEffect(() => {
    if (snap.status !== 'live') return
    const stop = desk.watch()
    const t = setInterval(() => setFrames(desk.get()?.frames ?? 0), 2000)
    return () => {
      stop()
      clearInterval(t)
    }
  }, [snap.status])

  async function start() {
    if (!goal) return
    setStarting(true)
    setError(null)
    try {
      await live.start(goal.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  async function finish() {
    setEnding(true)
    try {
      await live.finish()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEnding(false)
    }
  }

  if (snap.status !== 'live') {
    return (
      <div className="grid h-full place-items-center px-10 pb-16">
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="flex flex-col gap-1">
            <h1 className="text-title-2 font-semibold text-text">
              {looking ? 'Looking for your desk…' : 'No session'}
            </h1>
            {goal ? <p className="text-body text-text-faint">{goal.objective}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void start()} loading={starting} disabled={looking || !goal}>
              Start session
            </Button>
            <Button variant="ghost" onClick={() => void live.attach()} disabled={looking || starting}>
              Check again
            </Button>
          </div>
          {error ? <p className="text-small text-danger">{error}</p> : null}
          {!goal && !looking ? (
            <p className="text-small text-text-faint">Set a goal first, in Goal.</p>
          ) : null}
        </div>
      </div>
    )
  }

  const sessionGoal = snap.goal
  const budget = sessionGoal?.timeBudgetMinutes ?? null
  const interruptions = snap.observations.filter((o) => o.tier >= 2).length

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-8 pb-12 pt-2">
      <header className="flex items-start justify-between gap-8">
        <h1 className="text-title-1 font-semibold tracking-tight text-balance text-text">
          {sessionGoal?.objective ?? 'Session'}
        </h1>
        <div className="flex shrink-0 flex-col items-end">
          <span className="tnum text-title-1 font-semibold tracking-tight text-text">
            {clock ?? `${d.minutes}m`}
          </span>
          <span className="tnum text-small text-text-faint">
            {budget ? `of ${budget} min` : 'no budget'}
          </span>
        </div>
      </header>

      <Viewport sessionId={snap.session?.id ?? null} />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <Thinking
          latest={d.latest}
          latestSurvey={d.latestSurvey}
          since={snap.session?.startedAt ?? null}
          frames={frames}
          interruptions={interruptions}
        />
        <Attention observations={d.windows} goal={sessionGoal ?? goal} />
      </div>

      <Phone sessionId={snap.session?.id ?? null} goal={sessionGoal ?? goal} />

      <section className="flex flex-col gap-3">
        <Ribbon
          observations={d.windows}
          minutes={budget}
          breaks={breakMarks(sessionGoal, Math.max(budget ?? 0, d.minutes))}
        />
        <RibbonLegend />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle aside={d.quietFor >= 3 ? `quiet for ${d.quietFor} min` : undefined}>
          Interruptions
        </SectionTitle>
        <Actions
          observations={d.windows}
          settled={(o) => settledOutcome(snap, o) !== null}
          empty="None. It stays quiet while you are on the goal."
        />
      </section>

      <Signals />

      <Button variant="ghost" size="sm" className="self-start" onClick={() => void finish()} loading={ending}>
        End session
      </Button>
    </div>
  )
}
