import { LiveDot, Sparkline, TierBadge } from '@heli/ui'

const RATIO = [0.97, 0.95, 1, 0.98, 0.93, 0.97, 1, 0.96, 0.3, 0.05, 0.02, 0.9, 0.98, 1, 0.97, 0.99]

/**
 * The hero is the product, not a picture of it: the desktop's live panel on the pinned console
 * surface, and the nudge it just sent sitting over it. Static markup, no client JS.
 */
export function HeroConsole() {
  return (
    <div className="relative mx-auto mt-16 w-full max-w-[520px] lg:mx-0">
      <div
        data-surface="console"
        className="overflow-hidden rounded-lg border border-border bg-bg text-text shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="size-2.5 rounded-pill bg-ink-600" />
          <span className="size-2.5 rounded-pill bg-ink-600" />
          <span className="size-2.5 rounded-pill bg-ink-600" />
          <span className="ml-3 flex items-center gap-2 text-caption text-text-muted">
            <LiveDot state="live" /> Watching · Desk 1
          </span>
          <span className="tnum ml-auto font-mono text-[11px] text-text-faint">27:14 / 50:00</span>
        </div>

        <div className="flex flex-col gap-5 p-5">
          <div>
            <span className="text-label uppercase text-text-faint">Goal</span>
            <p className="mt-1 text-title-3 font-semibold">Finish the linear algebra problem set</p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Figure label="Focused" value="22" unit="min" />
            <Figure label="Off task" value="3" unit="min" />
            <Figure label="Switches" value="7" />
          </div>

          <div className="rounded-md border border-border bg-surface p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-caption text-text-muted">On task, last 16 min</span>
              <span className="tnum text-caption text-accent">97%</span>
            </div>
            <Sparkline
              values={RATIO}
              threshold={0.7}
              height={44}
              label="On-task ratio"
              className="text-accent"
            />
          </div>

          <ol className="flex flex-col gap-2.5 text-small">
            <Row ts="13:01" silent label="12 windows, on the goal" />
            <Row ts="13:03" tier={2} label="Nudge sent" note="ignored" />
            <Row ts="13:04" tier={3} label="Said it out loud" note="back in 38s" good />
            <Row ts="13:05" silent label="on the goal since" />
          </ol>
        </div>
      </div>

      {/* The nudge, as macOS shows it. Two actions, never a bare toast. */}
      <div className="absolute -right-3 -top-20 w-[300px] rounded-md border border-border bg-surface-raised/95 p-3.5 shadow-lg backdrop-blur sm:-right-10 lg:-right-16">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-accent-strong">
            <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
              <rect
                x="4.5"
                y="6.2"
                width="15"
                height="2.1"
                rx="1.05"
                className="fill-accent-contrast"
              />
              <rect x="11" y="7.5" width="2" height="4" className="fill-accent-contrast" />
              <circle cx="12" cy="15" r="3.6" className="fill-accent-contrast" />
              <circle cx="12" cy="15" r="1.4" className="fill-accent-strong" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-small font-semibold text-text">Helicopter</span>
              <span className="text-caption text-text-faint">now</span>
            </div>
            <p className="text-small text-text-muted">
              Back to the problem set when you get a sec.
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <span className="rounded-sm bg-surface py-1.5 text-center text-caption font-medium text-text">
            Back to the goal
          </span>
          <span className="rounded-sm bg-surface py-1.5 text-center text-caption font-medium text-text-muted">
            Snooze 10m
          </span>
        </div>
      </div>
    </div>
  )
}

function Figure({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label uppercase text-text-faint">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="tnum text-title-1 font-semibold">{value}</span>
        {unit ? <span className="text-caption text-text-muted">{unit}</span> : null}
      </span>
    </div>
  )
}

function Row({
  ts,
  label,
  silent,
  tier,
  note,
  good,
}: {
  ts: string
  label: string
  silent?: boolean
  tier?: number
  note?: string
  good?: boolean
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="tnum w-10 font-mono text-[11px] text-text-faint">{ts}</span>
      {silent ? (
        <span className="flex h-4 items-center gap-[3px]" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="h-3 w-[3px] rounded-pill bg-accent/50" />
          ))}
        </span>
      ) : (
        <TierBadge tier={tier ?? 0} />
      )}
      <span className={silent ? 'text-text-faint' : 'text-text'}>{label}</span>
      {note ? (
        <span className={`ml-auto text-caption ${good ? 'text-accent' : 'text-text-faint'}`}>
          {note}
        </span>
      ) : null}
    </li>
  )
}
