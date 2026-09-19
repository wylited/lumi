import type { Observation, Outcome } from '@heli/contracts'

/** One vocabulary for a minute's state, used by every chart in the app. */
export type MinuteState = 'focus' | 'glance' | 'drift' | 'break' | 'unknown'

export function stateOf(o: Observation): MinuteState {
  const a = o.assessment
  if (!a) return 'unknown'
  if (a.activity === 'break') return 'break'
  if (!a.onTask) return 'drift'
  return o.signals.offTaskSeconds > 0 ? 'glance' : 'focus'
}

export const FILL: Record<MinuteState | 'empty', string> = {
  focus: 'bg-accent',
  glance: 'bg-jade-300',
  drift: 'bg-warn',
  break: 'bg-ink-200',
  unknown: 'bg-ink-100',
  empty: 'bg-ink-100/70',
}

/** What the system did, as a verb. Tiers are an implementation detail; people read verbs. */
export const VERB: Record<number, string> = {
  1: 'Tray',
  2: 'Nudged',
  3: 'Spoke',
  4: 'Changed',
  5: 'Summary',
}

export const OUTCOME: Record<Outcome, { label: string; className: string }> = {
  resolved: { label: 'Came back', className: 'text-accent-link' },
  ignored: { label: 'Ignored', className: 'text-text-faint' },
  reverted: { label: 'Undone', className: 'text-danger' },
  unknown: { label: 'Not judged', className: 'text-text-faint' },
}
