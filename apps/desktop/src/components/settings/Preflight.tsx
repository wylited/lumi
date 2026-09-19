import { useState } from 'react'
import { Button, cn } from '@heli/ui'
import { startOver, runPreflight, type Check } from '../../lib/preflight'

const DOT = { ok: 'bg-accent', warn: 'bg-warn', fail: 'bg-danger' } as const

/** The night-before run: every line green, or the command that makes it green. */
export function Preflight() {
  const [checks, setChecks] = useState<Check[]>([])
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function run() {
    setRunning(true)
    setChecks([])
    await runPreflight((c) => setChecks((cs) => [...cs, c]))
    setRunning(false)
  }

  const allGreen = checks.length > 0 && !running && checks.every((c) => c.state === 'ok')
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-small font-medium text-text-muted">Before the room</h2>
        <div className="flex items-center gap-2">
          {confirming ? (
            <>
              <span className="text-small text-text-faint">Close the session and start over?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void startOver()}>
                Reset
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Start over
            </Button>
          )}
          <Button size="sm" onClick={() => void run()} loading={running}>
            {checks.length ? 'Run again' : 'Run preflight'}
          </Button>
        </div>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {checks.length === 0 && !running ? (
          <p className="px-4 py-3 text-small text-text-faint">
            Seven checks, top to bottom, the order things break in.
          </p>
        ) : null}
        {checks.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className={cn('size-2 shrink-0 rounded-pill', DOT[c.state])} />
              <span className="flex-1 text-body text-text">{c.label}</span>
              <span className="text-small text-text-faint">{c.detail}</span>
            </div>
            {c.fix ? (
              <code
                className="ml-[18px] self-start rounded-[4px] bg-surface px-1.5 py-0.5 font-mono text-[12px] text-text"
                data-selectable
              >
                {c.fix}
              </code>
            ) : null}
          </div>
        ))}
        {allGreen ? (
          <p className="px-4 py-3 text-small text-accent-link">All green. Ready for the room.</p>
        ) : null}
      </div>
    </section>
  )
}
