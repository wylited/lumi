import { useEffect, useState } from 'react'
import { Button, Card, CardBody, Sparkline } from '@heli/ui'
import { Budget } from '../components/session/Budget'
import { Feed } from '../components/session/Feed'
import { Metrics } from '../components/session/Metrics'
import { NowLine } from '../components/session/NowLine'
import { WindowPanel } from '../components/session/WindowPanel'
import { derive, live, useLive } from '../lib/live'

export function LiveRoute() {
  const snap = useLive()
  const d = derive(snap)
  const [attaching, setAttaching] = useState(false)

  // On open, join whatever session the desk already has running.
  useEffect(() => {
    if (live.get().status !== 'idle') return
    setAttaching(true)
    void live.attach().finally(() => setAttaching(false))
  }, [])

  if (snap.status !== 'live') {
    return (
      <div className="grid h-full place-items-center p-10">
        <div className="flex max-w-[440px] flex-col items-center gap-5 text-center">
          <span className="grid size-14 place-items-center rounded-pill bg-surface">
            <span className="size-3 rounded-pill border-2 border-ink-300" />
          </span>
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 font-semibold text-text">
              {attaching ? 'Looking for your desk…' : 'No session running'}
            </h2>
            <p className="text-small text-text-muted">
              A session starts when the desk unit sees you sit down with a goal set. Until then,
              nothing is watched.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => live.startDemo('drifting')} disabled={attaching}>
              Run the demo session
            </Button>
            <Button variant="ghost" onClick={() => void live.attach()} disabled={attaching}>
              Check again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const quiet = d.quietFor >= 3

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-8 px-8 py-8">
      <Budget goal={snap.goal} minutes={d.minutes} />
      <NowLine latest={d.latest} speaking={snap.deviceState === 'speaking'} />
      <Metrics d={d} />

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between">
              <span className="text-label uppercase text-text-faint">
                On task, minute by minute
              </span>
              <span className="tnum text-small text-text-muted">
                last {Math.min(d.ratios.length, 30)} min ·{' '}
                <span className="text-text">
                  {d.ratios.length
                    ? Math.round(
                        (d.ratios.slice(-30).reduce((a, b) => a + b, 0) /
                          Math.min(d.ratios.length, 30)) *
                          100,
                      )
                    : 0}
                  %
                </span>
              </span>
            </div>
            <Sparkline
              values={d.ratios}
              capacity={30}
              threshold={0.7}
              height={96}
              label="On-task ratio per minute"
              className="text-accent"
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-4">
            <span className="text-label uppercase text-text-faint">This minute</span>
            <WindowPanel window={snap.window} />
          </CardBody>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-title-3 font-semibold text-text">What it did</h3>
          {quiet ? (
            <span className="text-small text-accent-link">
              Nothing needed saying for {d.quietFor} min.
            </span>
          ) : null}
        </div>
        <Feed snap={snap} />
      </section>

      {snap.source === 'demo' ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => live.end()}>
            End demo session
          </Button>
        </div>
      ) : null}
    </div>
  )
}
