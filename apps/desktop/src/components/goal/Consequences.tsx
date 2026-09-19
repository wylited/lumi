import { TierBadge } from '@heli/ui'
import type { GoalForm } from '../../lib/goals'

function secs(ms: number) {
  const s = Math.round(ms / 1000)
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`
  return s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`
}

/** The goal, read back as what the system will and will not do. No jargon, no tier numbers first. */
export function Consequences({ form }: { form: GoalForm }) {
  const p = form.policy
  const may = (x: 'nudge' | 'speak' | 'automate') => form.permissions.includes(x)
  const rows: Array<{ tier: number; on: boolean; text: string }> = [
    { tier: 0, on: true, text: 'Stay silent while you are on the goal. Most minutes end here.' },
    {
      tier: 1,
      on: true,
      text: `Turn the tray and the desk light amber after ${p.driftSeconds} s off the goal.`,
    },
    {
      tier: 2,
      on: may('nudge'),
      text: may('nudge')
        ? `Send a notification if it lasts two windows — at most one every ${secs(p.nudgeGapMs)}.`
        : 'Never send a notification.',
    },
    {
      tier: 3,
      on: may('speak'),
      text: may('speak')
        ? `Say one sentence out loud if the nudge does not work — at most every ${secs(p.minGapMs)}.`
        : 'Never speak.',
    },
    {
      tier: 4,
      on: may('automate'),
      text: may('automate')
        ? form.automations.length
          ? `Change the machine (${form.automations.map((a) => a.replace(/_/g, ' ')).join(', ')}), shown and undoable in one click.`
          : 'Change the machine — pick which changes below.'
        : 'Never change your machine.',
    },
  ]
  return (
    <div className="flex flex-col gap-4">
      <span className="text-label uppercase text-text-faint">What this goal lets it do</span>
      <ol className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.tier} className={`flex items-start gap-3 ${r.on ? '' : 'opacity-55'}`}>
            {r.on ? (
              <TierBadge tier={r.tier} compact className="mt-0.5 shrink-0" />
            ) : (
              <span className="mt-0.5 inline-flex w-[46px] shrink-0 justify-center rounded-pill border border-dashed border-border-strong py-[3px] font-mono text-[11px] leading-none text-text-faint">
                off
              </span>
            )}
            <span className={`text-small ${r.on ? 'text-text' : 'text-text-faint'}`}>{r.text}</span>
          </li>
        ))}
      </ol>
      <p className="border-t border-border pt-4 text-caption text-text-faint">
        Only when it is at least {Math.round(p.minConfidence * 100)}% sure. Keystrokes and page
        contents are never read.
      </p>
    </div>
  )
}
