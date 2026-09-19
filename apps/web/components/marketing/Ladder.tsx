import { TierBadge } from '@heli/ui'

const RUNGS = [
  { tier: 0, what: 'Log it. Say nothing.', when: 'By default. Most windows end here.' },
  {
    tier: 1,
    what: 'The tray and the desk light turn amber.',
    when: 'Drift noticed, not yet worth an interruption.',
  },
  {
    tier: 2,
    what: 'A notification: back to the goal, or snooze.',
    when: 'Off the goal for 30 s, two windows running.',
  },
  {
    tier: 3,
    what: 'One sentence, out loud. Stop it with a word.',
    when: 'The nudge did not work and the drift continues.',
  },
  {
    tier: 4,
    what: 'Mute the site, pause the chat, start the break.',
    when: 'Only if your goal grants it. Undo in one click.',
  },
  { tier: 5, what: 'The recap: what worked, what did not.', when: 'When the session closes.' },
]

/** Each rung is indented by its tier, so the page draws the escalation instead of describing it. */
export function Ladder() {
  return (
    <ol className="flex flex-col gap-2">
      {RUNGS.map((r) => (
        <li
          key={r.tier}
          className="grid items-center gap-x-6 gap-y-1 rounded-md border border-border bg-bg px-5 py-4 md:grid-cols-[130px_1fr_1fr]"
          style={{ marginLeft: `min(${r.tier * 5}%, ${r.tier * 48}px)` }}
        >
          <TierBadge tier={r.tier} />
          <span className="text-body-strong font-medium text-text">{r.what}</span>
          <span className="text-small text-text-faint">{r.when}</span>
        </li>
      ))}
    </ol>
  )
}
