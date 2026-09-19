import type { Assessment, Automation, Goal, Intervention, SignalWindow } from '@heli/contracts'

/**
 * The intervention policy. Pure, synchronous and dependency-free: it owns the
 * judgment, and nothing reaches a notification, a speaker or a machine action
 * unless this file says so. `null` is silence (tier 0) and is the common case.
 */

export interface PolicyInput {
  assessment: Assessment
  window: SignalWindow
  goal: Goal
  now: number
  lastSpokenAt: number | null
  lastNudgeAt: number | null
  consecutiveOffGoal: number
  automationsThisSession: number
  recentOutcomes: { tier: number; kind: string | null; outcome: string }[]
}

/**
 * Adaptation is explainable and bounded. Every adapted value stays inside
 * these constants — never below the base, never above the ceiling factor.
 */
export const ADAPTATION = {
  /** Outcomes needed before a channel's resolve rate is trusted. */
  minSamples: 3,
  /** A channel below this resolve rate is not working; widen its gap. */
  resolveRateFloor: 0.34,
  /** Low resolve widens the gap by this factor (annoy less). */
  widenFactor: 1.5,
  /** Hard ceiling: a gap is never widened past this multiple of its base. */
  widenCeilingFactor: 3,
  /** Repeated `ignored` for one kind lets us step up a tier one window sooner. */
  escalationStreak: 2,
} as const

const AMBIENT_TIER = 1
const NUDGE_TIER = 2
const SPEECH_TIER = 3
const AUTOMATION_TIER = 4

export function decide(input: PolicyInput): Intervention | null {
  const { assessment, window, goal, now, lastSpokenAt, lastNudgeAt, recentOutcomes } = input
  const policy = goal.policy
  const kind = assessment.kind

  // Rule 1 — doubt is silence. One noisy assessment never interrupts.
  if (assessment.confidence < policy.minConfidence) return null

  // Rule 1b — nobody is there to act on. An empty desk is silence: nudging an
  // empty room is noise. (`activity` is the model's read; a merely idle screen
  // is not enough — reading a page looks idle too.)
  if (assessment.activity === 'away') return null

  // A window that comes back on goal resolves itself: tier 0, counters reset.
  if (assessment.onTask) return null

  // Rule 2 — evidence must be sustained, not a single sample. Drift that is real
  // but not yet sustained is the ambient case: the tray changes, nobody is
  // interrupted.
  if (assessment.driftSeconds < policy.driftSeconds) return null
  if (input.consecutiveOffGoal < policy.consecutiveOffGoal) {
    if (policy.maxTier < AMBIENT_TIER) return null
    return {
      tier: AMBIENT_TIER,
      channel: 'ambient',
      message: null,
      action: null,
      reversible: false,
      reason: `tier${AMBIENT_TIER}:ambient:not_sustained`,
    }
  }

  // Rule 3 — each channel has its own gap. Both gaps adapt (see `adaptedGap`).
  const nudgeGapMs = adaptedGap(policy.nudgeGapMs, NUDGE_TIER, recentOutcomes)
  const speechGapMs = adaptedGap(policy.minGapMs, SPEECH_TIER, recentOutcomes)
  const nudgeDue = lastNudgeAt === null || now - lastNudgeAt >= nudgeGapMs
  const speechDue = lastSpokenAt === null || now - lastSpokenAt >= speechGapMs

  // Permissions gate every channel. An automation also needs a non-empty list.
  const canNudge = goal.permissions.includes('nudge')
  const canSpeak = goal.permissions.includes('speak')
  const canAutomate =
    goal.permissions.includes('automate') && goal.automations.length > 0
  const automationAvailable =
    canAutomate && input.automationsThisSession < policy.maxAutomationsPerSession
  const firstAutomation: Automation | undefined = goal.automations[0]

  // The ladder looks at the most recent real intervention for this kind.
  const last = lastEscalation(recentOutcomes, kind)
  const ignoredStreak = leadingIgnoredStreak(recentOutcomes, kind)

  let idealTier = NUDGE_TIER
  let ladderReason = 'nudge_due'
  if (last !== undefined && last.outcome === 'ignored') {
    if (last.tier >= SPEECH_TIER) {
      // A nudge was unresolved, then a spoken line was unresolved: automate.
      idealTier = AUTOMATION_TIER
      ladderReason = 'speak_ignored'
    } else if (ignoredStreak >= ADAPTATION.escalationStreak) {
      // Adaptation: a kind that keeps getting ignored steps up one window sooner.
      idealTier = AUTOMATION_TIER
      ladderReason = 'escalated_sooner'
    } else {
      // A nudge was unresolved: that is what earns a spoken line.
      idealTier = SPEECH_TIER
      ladderReason = 'nudge_ignored'
    }
  }

  const driftConfirmed =
    last !== undefined &&
    last.outcome === 'ignored' &&
    (last.tier >= SPEECH_TIER || ignoredStreak >= ADAPTATION.escalationStreak)

  // Walk down from the ideal tier. Take the highest tier that both satisfies its
  // own rule and stays within `maxTier`; otherwise fall to ambient, or silence.
  if (
    idealTier >= AUTOMATION_TIER &&
    driftConfirmed &&
    automationAvailable &&
    firstAutomation !== undefined &&
    policy.maxTier >= AUTOMATION_TIER
  ) {
    return {
      tier: AUTOMATION_TIER,
      channel: 'automation',
      message: automationMessage(firstAutomation),
      action: firstAutomation,
      reversible: true,
      reason: `tier${AUTOMATION_TIER}:automation:${ladderReason}`,
    }
  }

  if (idealTier >= SPEECH_TIER && canSpeak && speechDue && policy.maxTier >= SPEECH_TIER) {
    return {
      tier: SPEECH_TIER,
      channel: 'speech',
      message: speechMessage(goal),
      action: null,
      reversible: false,
      reason: `tier${SPEECH_TIER}:speak:${speechFallbackReason(idealTier, ladderReason, policy.maxTier, canAutomate)}`,
    }
  }

  if (idealTier >= NUDGE_TIER && canNudge && nudgeDue && policy.maxTier >= NUDGE_TIER) {
    // Focus / Do Not Disturb downgrades a notification to a tray-colour nudge.
    if (window.focusMode) {
      return {
        tier: AMBIENT_TIER,
        channel: 'ambient',
        message: null,
        action: null,
        reversible: false,
        reason: `tier${AMBIENT_TIER}:ambient:focus_mode`,
      }
    }
    return {
      tier: NUDGE_TIER,
      channel: 'notification',
      message: nudgeMessage(goal),
      action: null,
      reversible: false,
      reason: `tier${NUDGE_TIER}:nudge:nudge_due`,
    }
  }

  // Ambient: drift is real but there is no reason to interrupt. It changes the
  // tray colour only, and it still respects `maxTier`.
  if (policy.maxTier >= AMBIENT_TIER) {
    return {
      tier: AMBIENT_TIER,
      channel: 'ambient',
      message: null,
      action: null,
      reversible: false,
      reason: `tier${AMBIENT_TIER}:ambient:${ambientReason(canNudge, nudgeDue)}`,
    }
  }

  return null
}

/**
 * Adaptation, part one: where a channel has a low resolve rate over enough
 * samples, widen that channel's gap so we annoy less. Bounded by `widenFactor`
 * below and `widenCeilingFactor` above; never shrinks.
 */
function adaptedGap(
  baseMs: number,
  tier: number,
  outcomes: PolicyInput['recentOutcomes'],
): number {
  const samples = outcomes.filter((o) => o.tier === tier)
  if (samples.length < ADAPTATION.minSamples) return baseMs
  const resolved = samples.filter((o) => o.outcome === 'resolved').length
  const resolveRate = resolved / samples.length
  if (resolveRate >= ADAPTATION.resolveRateFloor) return baseMs
  const widened = Math.round(baseMs * ADAPTATION.widenFactor)
  const ceiling = Math.round(baseMs * ADAPTATION.widenCeilingFactor)
  return Math.min(widened, ceiling)
}

/** The most recent nudge-or-higher intervention recorded for this kind. */
function lastEscalation(
  outcomes: PolicyInput['recentOutcomes'],
  kind: string | null,
): PolicyInput['recentOutcomes'][number] | undefined {
  return outcomes.find((o) => o.tier >= NUDGE_TIER && o.kind === kind)
}

/**
 * Adaptation, part two: how many of this kind's most recent escalated outcomes
 * were ignored in a row. Enough of them lets us step up a tier sooner.
 */
function leadingIgnoredStreak(
  outcomes: PolicyInput['recentOutcomes'],
  kind: string | null,
): number {
  let streak = 0
  for (const o of outcomes) {
    if (o.tier < NUDGE_TIER || o.kind !== kind) continue
    if (o.outcome === 'ignored') streak += 1
    else break
  }
  return streak
}

function speechFallbackReason(
  idealTier: number,
  ladderReason: string,
  maxTier: number,
  canAutomate: boolean,
): string {
  if (idealTier <= SPEECH_TIER) return ladderReason
  if (maxTier < AUTOMATION_TIER) return 'max_tier'
  if (!canAutomate) return 'automation_not_granted'
  return 'automation_capped'
}

function ambientReason(canNudge: boolean, nudgeDue: boolean): string {
  if (!canNudge) return 'nudge_denied'
  if (!nudgeDue) return 'nudge_gap'
  return 'max_tier'
}

function nudgeMessage(goal: Goal): string {
  return `You have drifted from "${goal.objective}". Want to get back to it?`
}

function speechMessage(goal: Goal): string {
  return `You have been off task for a bit. Let's return to "${goal.objective}".`
}

function automationMessage(action: Automation): string {
  switch (action) {
    case 'pause_notifications':
      return 'Pausing notifications so you can refocus.'
    case 'open_app':
      return 'Opening your workspace to help you get back on task.'
    case 'navigate_tab':
      return 'Bringing your goal tab back to the front.'
    case 'mute_site':
      return 'Muting the distracting site for this session.'
    case 'start_break':
      return 'Starting a short break so you can reset.'
    case 'start_timer':
      return 'Starting a focus timer.'
  }
}
