import type {
  Assessment,
  Automation,
  ClutterLabel,
  ClutterReading,
  Goal,
  Intervention,
  Policy,
  SignalWindow,
} from '@heli/contracts'

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
  /**
   * The desk survey's newest reading, when there is one — the only thing that may
   * interrupt a person who is **on** task. Every existing caller decides with no
   * survey at all, so this is optional and absent means the clutter rule never
   * fires.
   */
  clutter?: {
    reading: ClutterReading
    /** When the sweep's row was written, for the freshness rule. */
    at: number
    /** The sweep's poses in order, so the worst hotspot can be pointed at. */
    poses: { aim: { x: number; y: number } | null }[]
    /** The last desk **line**: its time and the score it spoke about. */
    lastSpokenAt: number | null
    lastSpokenScore: number | null
    pointedThisSession: boolean
  } | null
}

/**
 * When the loop asks the rig to sweep the desk, as opposed to when it speaks.
 *
 * Two constants, both about not wasting the camera: nothing sweeps in the first
 * two minutes of a session, because a reading taken while someone is still
 * settling in is a reading of nothing; and a desk that has been empty for two
 * minutes is worth one sweep from wherever the camera already points, because
 * that costs no arm time at all.
 */
export const SURVEY = { startDelayMs: 120_000, awayIdleSeconds: 120 } as const

export type SurveyTrigger = 'start' | 'away' | 'floor'

export interface SurveyDueInput {
  now: number
  idleSeconds: number
  sessionStartedAt: number
  /**
   * When a sweep was last *asked for* — not when one last succeeded. The loop
   * spends the gap on a refusal too: otherwise a rig that refuses every sweep
   * leaves this untouched and the next window is asked again, forever.
   */
  lastSurveyAt: number | null
  /** Whether the last sweep was the away one, so one absence means one sweep. */
  lastSurveyAway: boolean
  deskConnected: boolean
  policy: Policy
}

/**
 * Whether a sweep is due, and why. Pure and clock-injected, so the whole table is
 * tested without a rig: a desk that is not there sweeps nothing; the gap wins over
 * every other reason; a young session sweeps only once the person has left; the
 * first reading after the delay is the `start` one; an absence earns one sweep;
 * and the floor is the slow heartbeat behind all of it.
 */
export function surveyDue(input: SurveyDueInput): SurveyTrigger | null {
  if (!input.deskConnected) return null

  if (input.lastSurveyAt !== null && input.now - input.lastSurveyAt < input.policy.surveyGapMs) {
    return null
  }

  if (input.lastSurveyAt === null) {
    // Nothing has ever been read. Before the start delay, the only sweep worth
    // taking is one of an empty desk; after it, the reading is the start one.
    if (input.now - input.sessionStartedAt < SURVEY.startDelayMs) {
      return input.idleSeconds >= SURVEY.awayIdleSeconds ? 'away' : null
    }
    return 'start'
  }

  // One sweep per absence: the first window that finds them gone, and no more
  // until they come back and leave again.
  if (input.idleSeconds >= SURVEY.awayIdleSeconds && !input.lastSurveyAway) return 'away'

  if (input.now - input.lastSurveyAt >= input.policy.surveyFloorMs) return 'floor'
  return null
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
  // The one thing that may still interrupt is the desk survey — a person can be
  // perfectly on task at a desk with no room left to work on it.
  if (assessment.onTask) {
    return input.clutter ? clutterDecision(input, input.clutter) : null
  }

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

  // Voice first: when the goal allows speaking, the first interruption is the spoken line, and
  // the notification rung is skipped — not merged into it. A goal that does not allow speaking
  // climbs from the nudge as before. After an ignored line, the next step is still a change.
  const voiceFirst = canSpeak && policy.maxTier >= SPEECH_TIER
  let idealTier = voiceFirst ? SPEECH_TIER : NUDGE_TIER
  let ladderReason = voiceFirst ? 'voice_first' : 'nudge_due'
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

  // Between two spoken lines a voice-first goal waits in ambient, never falls back to a nudge.
  if (!voiceFirst && idealTier >= NUDGE_TIER && canNudge && nudgeDue && policy.maxTier >= NUDGE_TIER) {
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
      reason: `tier${AMBIENT_TIER}:ambient:${voiceFirst ? 'voice_first_gap' : ambientReason(canNudge, nudgeDue)}`,
    }
  }

  return null
}

/**
 * How long a reading stays worth speaking about.
 *
 * A sweep costs arm time and a model call, and the person keeps using the desk
 * after it: ten minutes on, a reading is a picture of a surface they have been
 * moving things around on since. Speaking to a stale reading is speaking about
 * the wrong desk.
 */
const CLUTTER_FRESH_MS = 600_000

/**
 * The desk line, when it is worth one.
 *
 * Reached only from the on-task branch of `decide`: the drift ladder owns the
 * airtime whenever the person is off goal, and an empty desk is never spoken to
 * (`activity === 'away'` silences above this). Everything here is about the
 * interruption being worth it — the reading is fresh and confident, the desk is
 * actually cluttered, it is worse than the last thing we said about it, the goal
 * allows speaking, and both gaps have passed.
 */
function clutterDecision(
  input: PolicyInput,
  clutter: NonNullable<PolicyInput['clutter']>,
): Intervention | null {
  const policy = input.goal.policy
  const { reading } = clutter

  // Doubt is silence here exactly as it is for an assessment.
  if (reading.confidence < policy.minConfidence) return null
  if (input.now - clutter.at > CLUTTER_FRESH_MS) return null
  // Nothing worth mentioning: a desk in use is not a cluttered desk.
  if (reading.score < policy.clutterSpeakScore) return null
  // It has to be worse than the last desk line, or the line repeats itself.
  if (
    clutter.lastSpokenScore !== null &&
    reading.score < clutter.lastSpokenScore + policy.clutterRiseDelta
  ) {
    return null
  }
  // Permissions gate this channel like every other one.
  if (!input.goal.permissions.includes('speak') || policy.maxTier < SPEECH_TIER) return null

  // A desk line goes out on the speech channel, so it waits the same adapted gap
  // the drift line waits — the channel's patience, not a second opinion's.
  const speechGapMs = adaptedGap(policy.minGapMs, SPEECH_TIER, input.recentOutcomes)
  if (clutter.lastSpokenAt !== null && input.now - clutter.lastSpokenAt < speechGapMs) return null
  // And the slower desk gap on top of it: clutter returns slower than drift, and
  // two lines about the same pile minutes apart is nagging.
  if (
    clutter.lastSpokenScore !== null &&
    clutter.lastSpokenAt !== null &&
    input.now - clutter.lastSpokenAt < policy.clutterGapMs
  ) {
    return null
  }

  const worst = reading.hotspots[0] ?? null
  const aim = worst ? (clutter.poses[worst.poseIndex]?.aim ?? null) : null
  // The point needs three things: the goal grants `automate`, the sweep went
  // through a calibration so there is a place to aim at, and this session has not
  // already gestured at the desk.
  const point =
    input.goal.permissions.includes('automate') && aim !== null && !clutter.pointedThisSession
      ? aim
      : null

  return {
    tier: SPEECH_TIER,
    channel: 'speech',
    message: CLUTTER_LINES[worst?.label ?? 'other'],
    action: null,
    // A point is a gesture, not a change to the machine: nothing is left to undo,
    // and the tracker re-acquires the person as soon as the move ends.
    reversible: false,
    point,
    reason: `tier${SPEECH_TIER}:speak:clutter${worst ? `:${worst.label}` : ''}`,
  }
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

/**
 * The desk line, one per kind of thing that fills a desk.
 *
 * Templates, not model free text, for the same reason the drift lines are: the
 * model returns a reading (`ClutterReading`), and what the person hears is chosen
 * here from the worst hotspot's label. A reading with no hotspots still gets a
 * line, and it is the `other` one.
 */
const CLUTTER_LINES: Record<ClutterLabel, string> = {
  papers: 'Paper has taken over the desk. Clear the pile and get back to it.',
  cups: 'The cups have piled up. Take them out and settle back in.',
  dishes: 'Yesterday’s dishes are still on the desk. Clear them and get back to it.',
  food: 'There is food on the desk. Clear it away and get back to it.',
  cables: 'The cables have become a nest. Tidy them and get back to it.',
  clothes: 'Clothes have landed on the desk. Clear them and get back to it.',
  tools: 'Tools are spread across the desk. Put them away and get back to it.',
  boxes: 'Boxes are crowding the desk. Clear them and get back to it.',
  bottles: 'Bottles have collected on the desk. Take them out and get back to it.',
  other: 'The desk has filled up. Clear it and get back to it.',
}

/** The goal in the person's words, quoted once: a goal that already carries quotes is not wrapped. */
function quoted(objective: string): string {
  return /["“”]/.test(objective) ? objective : `"${objective}"`
}

function nudgeMessage(goal: Goal): string {
  return `You have drifted from ${quoted(goal.objective)}. Want to get back to it?`
}

function speechMessage(goal: Goal): string {
  return `You have been off task for a bit. Let's return to ${quoted(goal.objective)}.`
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
