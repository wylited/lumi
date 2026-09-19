import { useEffect, useState } from 'react'
import type { Goal } from '@heli/contracts'
import { Button } from '@heli/ui'
import { Dot, Figure, SectionTitle } from '../components/kit'
import { Actions } from '../components/session/Actions'
import { dur, mm } from '../components/session/format'
import { Ribbon, RibbonLegend } from '../components/session/Ribbon'
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

export function LiveRoute() {
  const snap = useLive()
  const d = derive(snap)
  const [looking, setLooking] = useState(false)

  useEffect(() => {
    if (live.get().status !== 'idle') return
    setLooking(true)
    void live.attach().finally(() => setLooking(false))
  }, [])

  if (snap.status !== 'live') {
    return (
      <div className="grid h-full place-items-center px-10 pb-16">
        <div className="flex flex-col items-center gap-5 text-center">
          <h1 className="text-title-2 font-semibold text-text">
            {looking ? 'Looking for your desk…' : 'No session'}
          </h1>
          <div className="flex items-center gap-2">
            <Button onClick={() => live.startDemo('drifting')} disabled={looking}>
              Run the demo
            </Button>
            <Button variant="ghost" onClick={() => void live.attach()} disabled={looking}>
              Check again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const goal = snap.goal
  const budget = goal?.timeBudgetMinutes ?? null
  const latest = d.latest
  const a = latest?.assessment
  const where = latest?.signals.topSites[0]?.title ?? latest?.signals.topApps[0]?.app ?? null
  const speaking = snap.deviceState === 'speaking'
  const state = !a
    ? 'Starting'
    : speaking
      ? 'Speaking'
      : a.activity === 'break'
        ? 'On a break'
        : a.onTask
          ? 'On the goal'
          : 'Off task'
  const drifting = !!a && !a.onTask && a.activity !== 'break'

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-10 px-10 pb-12 pt-2">
      <header className="flex items-start justify-between gap-8">
        <h1 className="text-title-1 font-semibold tracking-tight text-balance text-text">
          {goal?.objective ?? 'Session'}
        </h1>
        <div className="flex shrink-0 flex-col items-end">
          <span className="tnum text-title-1 font-semibold tracking-tight text-text">
            {d.minutes}m
          </span>
          <span className="tnum text-small text-text-faint">
            {budget ? `of ${budget}` : 'no budget'}
          </span>
        </div>
      </header>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Dot tone={drifting ? 'drift' : 'focus'} />
          <span className="text-body-strong font-semibold text-text">{state}</span>
          {where && a?.activity !== 'break' ? (
            <span className="text-body text-text-faint">{where}</span>
          ) : null}
          {drifting && a ? (
            <span className="tnum ml-auto text-body-strong font-semibold text-warn">
              {dur(a.driftSeconds)}
            </span>
          ) : null}
        </div>
        <Ribbon
          observations={snap.observations}
          minutes={budget}
          breaks={breakMarks(goal, Math.max(budget ?? 0, d.minutes))}
        />
        <RibbonLegend />
      </section>

      <section className="flex gap-14">
        <Figure value={mm(d.focusedMinutes * 60)} label="Focused" />
        <Figure
          value={mm(d.offTaskMinutes * 60)}
          label="Off task"
          tone={d.offTaskMinutes >= 5 ? 'warn' : undefined}
        />
        <Figure value={mm(d.longestRunSeconds)} label="Longest run" />
        <Figure
          value={d.minutes ? (d.switches / d.minutes).toFixed(1) : '0'}
          label="Switches / min"
        />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle aside={d.quietFor >= 3 ? `quiet for ${d.quietFor} min` : undefined}>
          Interruptions
        </SectionTitle>
        <Actions
          observations={snap.observations}
          settled={(o) => settledOutcome(snap, o) !== null}
          empty="None. It stays quiet while you are on the goal."
        />
      </section>

      {snap.source === 'demo' ? (
        <button
          type="button"
          onClick={() => live.end()}
          className="self-start text-small text-text-faint underline-offset-4 hover:text-text hover:underline"
        >
          End demo
        </button>
      ) : null}
    </div>
  )
}
