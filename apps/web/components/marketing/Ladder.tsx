import { cn } from '@heli/ui'

const STEPS = [
  { name: 'Silent', does: 'Logs the minute. Most minutes end here.', when: 'You are on the goal', dot: 'bg-ink-300' },
  { name: 'Tray', does: 'The menu bar and the desk light turn amber.', when: '30 s off the goal', dot: 'bg-jade-400' },
  { name: 'Nudge', does: 'A notification: back to the goal, or snooze.', when: 'Still off a minute later', dot: 'bg-warn' },
  { name: 'Voice', does: 'One sentence out loud. Talk over it to stop it.', when: 'The nudge did not work', dot: 'bg-text' },
  { name: 'Change', does: 'Mutes the site or starts the break. Undo in one click.', when: 'Only if you allow it', dot: 'bg-ink-500' },
] as const

const RISE = 22

/** The escalation as a staircase: each tread is earned by the one below it not working. */
export function Ladder() {
  return (
    <ol className="grid gap-8 sm:grid-cols-5 sm:gap-0">
      {STEPS.map((s, i) => (
        <li key={s.name} className="flex flex-col gap-5">
          <div className="relative hidden h-[112px] sm:block" aria-hidden="true">
            {/* the tread */}
            <span className="absolute left-0 right-0 h-px bg-text" style={{ bottom: i * RISE }} />
            {/* the riser up to the next tread */}
            {i < STEPS.length - 1 ? (
              <span className="absolute right-0 w-px bg-text" style={{ bottom: i * RISE, height: RISE }} />
            ) : null}
            <span className={cn('absolute left-0 size-2.5 rounded-pill', s.dot)} style={{ bottom: i * RISE - 4.5 }} />
          </div>
          <div className="flex flex-col gap-1.5 sm:pr-6">
            <span className="flex items-baseline gap-2">
              <span className="tnum text-small text-text-faint">{i}</span>
              <span className="text-body-strong font-semibold text-text">{s.name}</span>
            </span>
            <span className="text-small text-text-muted">{s.does}</span>
            <span className="text-small text-text-faint">{s.when}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}
