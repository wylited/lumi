import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ClutterReading, DEFAULT_POLICY, Goal } from '@heli/contracts'
import type { Assessment, Goal as GoalType, Intervention, SignalWindow } from '@heli/contracts'

import { decide, surveyDue, type PolicyInput, type SurveyDueInput } from '../src/observe/policy.ts'

const NOW = 1_800_000_000_000

function makeWindow(overrides: Partial<SignalWindow> = {}): SignalWindow {
  return {
    from: new Date(NOW - 60_000).toISOString(),
    to: new Date(NOW).toISOString(),
    windowMs: 60_000,
    focusedSeconds: 10,
    offTaskSeconds: 50,
    idleSeconds: 0,
    contextSwitches: 3,
    longestFocusRunSeconds: 5,
    inputRate: 1,
    onTaskRatio: 0.2,
    topApps: [],
    topSites: [],
    focusMode: false,
    lastFrameRef: 'frame-1',
    lastScreenRef: null,
    ...overrides,
  }
}

function makeGoal(overrides: Partial<GoalType> = {}): GoalType {
  return Goal.parse({
    id: 'goal-1',
    kind: 'study',
    objective: 'Finish the physics problem set',
    successCriteria: null,
    timeBudgetMinutes: 60,
    policy: DEFAULT_POLICY,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  })
}

function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    onTask: false,
    activity: 'phone',
    kind: 'social',
    driftSeconds: 45,
    evidence: ['phone in hand'],
    confidence: 0.9,
    because: 'the phone is in hand',
    ...overrides,
  }
}

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    assessment: makeAssessment(),
    window: makeWindow(),
    goal: makeGoal(),
    now: NOW,
    lastSpokenAt: null,
    lastNudgeAt: null,
    consecutiveOffGoal: 2,
    automationsThisSession: 0,
    recentOutcomes: [],
    ...overrides,
  }
}

const ignoredNudge = { tier: 2, kind: 'social', outcome: 'ignored' }
const ignoredSpeak = { tier: 3, kind: 'social', outcome: 'ignored' }

test('a self-resolving window is silence', () => {
  const result = decide(makeInput({ assessment: makeAssessment({ onTask: true }) }))
  assert.equal(result, null)
})

test('sustained drift produces a nudge', () => {
  const result = decide(makeInput())
  assert.equal(result?.tier, 2)
  assert.equal(result?.channel, 'notification')
  assert.equal(result?.reason, 'tier2:nudge:nudge_due')
})

test('an ignored nudge earns a spoken line on the next window', () => {
  const result = decide(
    makeInput({
      goal: makeGoal({ policy: { ...DEFAULT_POLICY, maxTier: 3 } }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge],
      lastNudgeAt: NOW - 200_000,
    }),
  )
  assert.equal(result?.tier, 3)
  assert.equal(result?.channel, 'speech')
  assert.equal(result?.reason, 'tier3:speak:nudge_ignored')
})

test('two off-goal windows 5 s apart produce exactly one nudge', () => {
  const first = decide(makeInput({ lastNudgeAt: null }))
  const second = decide(
    makeInput({
      now: NOW + 5_000,
      lastNudgeAt: NOW,
      consecutiveOffGoal: 3,
    }),
  )
  const nudges = [first, second].filter((i) => i?.tier === 2)
  assert.equal(nudges.length, 1)
  assert.equal(first?.tier, 2)
  assert.notEqual(second?.tier, 2)
})

test('maxTier:2 never produces a speak', () => {
  const result = decide(
    makeInput({
      goal: makeGoal({ policy: { ...DEFAULT_POLICY, maxTier: 2 } }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge],
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.ok(result === null || result.tier <= 2)
  assert.notEqual(result?.tier, 3)
})

test('permissions without speak never produce a spoken line', () => {
  const result = decide(
    makeInput({
      goal: makeGoal({
        permissions: ['nudge'] satisfies GoalType['permissions'],
        policy: { ...DEFAULT_POLICY, maxTier: 5 },
      }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge],
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.notEqual(result?.tier, 3)
  assert.equal(result?.channel, 'notification')
})

test('automation fires only when granted, available and within maxTier', () => {
  const granted = decide(
    makeInput({
      goal: makeGoal({
        permissions: ['nudge', 'speak', 'automate'] satisfies GoalType['permissions'],
        automations: ['pause_notifications'] satisfies GoalType['automations'],
        policy: { ...DEFAULT_POLICY, maxTier: 4 },
      }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredSpeak, ignoredNudge],
      lastSpokenAt: NOW - 400_000,
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.equal(granted?.tier, 4)
  assert.equal(granted?.channel, 'automation')
  assert.equal(granted?.action, 'pause_notifications')
  assert.equal(granted?.reversible, true)

  const denied = decide(
    makeInput({
      goal: makeGoal({
        permissions: ['nudge', 'speak'] satisfies GoalType['permissions'],
        automations: ['pause_notifications'] satisfies GoalType['automations'],
        policy: { ...DEFAULT_POLICY, maxTier: 4 },
      }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredSpeak, ignoredNudge],
      lastSpokenAt: NOW - 400_000,
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.equal(denied?.tier, 3)

  const capped = decide(
    makeInput({
      goal: makeGoal({
        permissions: ['nudge', 'speak', 'automate'] satisfies GoalType['permissions'],
        automations: ['pause_notifications'] satisfies GoalType['automations'],
        policy: { ...DEFAULT_POLICY, maxTier: 4 },
      }),
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredSpeak, ignoredNudge],
      lastSpokenAt: NOW - 400_000,
      lastNudgeAt: NOW - 400_000,
      automationsThisSession: DEFAULT_POLICY.maxAutomationsPerSession,
    }),
  )
  assert.notEqual(capped?.tier, 4)
  assert.equal(capped?.tier, 3)
})

test('focus mode downgrades a tier 2 nudge to ambient', () => {
  const result = decide(makeInput({ window: makeWindow({ focusMode: true }) }))
  assert.equal(result?.tier, 1)
  assert.equal(result?.channel, 'ambient')
  assert.equal(result?.reason, 'tier1:ambient:focus_mode')
})

test('adaptation widens the speech gap after low resolve', () => {
  const goal = makeGoal({ policy: { ...DEFAULT_POLICY, maxTier: 3 } })
  const control = decide(
    makeInput({
      goal,
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge],
      lastSpokenAt: NOW - 100_000,
      lastNudgeAt: NOW - 100_000,
    }),
  )
  assert.equal(control?.tier, 3)

  const widened = decide(
    makeInput({
      goal,
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredSpeak, ignoredSpeak, ignoredSpeak, ignoredNudge],
      lastSpokenAt: NOW - 100_000,
      lastNudgeAt: NOW - 100_000,
    }),
  )
  assert.notEqual(widened?.tier, 3)
})

test('adaptation steps up a tier one window sooner after repeated ignores', () => {
  const goal = makeGoal({
    permissions: ['nudge', 'speak', 'automate'] satisfies GoalType['permissions'],
    automations: ['pause_notifications'] satisfies GoalType['automations'],
    policy: { ...DEFAULT_POLICY, maxTier: 4 },
  })

  const normal = decide(
    makeInput({
      goal,
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge],
      lastSpokenAt: NOW - 400_000,
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.equal(normal?.tier, 3)

  const sooner = decide(
    makeInput({
      goal,
      consecutiveOffGoal: 3,
      recentOutcomes: [ignoredNudge, ignoredNudge],
      lastSpokenAt: NOW - 400_000,
      lastNudgeAt: NOW - 400_000,
    }),
  )
  assert.equal(sooner?.tier, 4)
})

test('voice first: a goal that may speak opens with the spoken line, not a nudge', () => {
  const goal = makeGoal({ permissions: ['nudge', 'speak'], policy: { ...DEFAULT_POLICY, maxTier: 3 } })
  const result = decide(makeInput({ goal }))
  assert.equal(result?.tier, 3)
  assert.equal(result?.channel, 'speech')
  assert.equal(result?.reason, 'tier3:speak:voice_first')
})

test('voice first: between two spoken lines it waits in ambient, never nudges', () => {
  const goal = makeGoal({ permissions: ['nudge', 'speak'], policy: { ...DEFAULT_POLICY, maxTier: 3 } })
  const result = decide(makeInput({ goal, lastSpokenAt: NOW - 5_000 }))
  assert.equal(result?.tier, 1)
  assert.equal(result?.channel, 'ambient')
  assert.equal(result?.reason, 'tier1:ambient:voice_first_gap')
})

test('a goal that may not speak still climbs from the nudge', () => {
  const goal = makeGoal({ permissions: ['nudge'], policy: { ...DEFAULT_POLICY, maxTier: 3 } })
  const result = decide(makeInput({ goal }))
  assert.equal(result?.tier, 2)
  assert.equal(result?.channel, 'notification')
})

/* ---- the desk survey ----------------------------------------------------- */

function makeReading(overrides: Partial<ClutterReading> = {}): ClutterReading {
  return ClutterReading.parse({
    score: 0.8,
    hotspots: [{ poseIndex: 0, label: 'papers', severity: 0.9, at: { x: 0.5, y: 0.5 } }],
    evidence: ['a stack of paper across the left half'],
    confidence: 0.9,
    because: 'paper and a cable nest',
    ...overrides,
  })
}

function makeClutter(
  overrides: Partial<NonNullable<PolicyInput['clutter']>> = {},
): NonNullable<PolicyInput['clutter']> {
  return {
    reading: makeReading(),
    at: NOW - 5_000,
    poses: [{ aim: null }],
    lastSpokenAt: null,
    lastSpokenScore: null,
    pointedThisSession: false,
    ...overrides,
  }
}

/** A goal that may speak, which is what every desk-line case below needs. */
function speakingGoal(permissions: GoalType['permissions'] = ['nudge', 'speak']): GoalType {
  return makeGoal({ permissions, policy: { ...DEFAULT_POLICY, maxTier: 3 } })
}

/** The desk line's entry point: an on-task window with a reading stashed. */
function withClutter(
  clutter: NonNullable<PolicyInput['clutter']>,
  goal: GoalType = speakingGoal(),
): Intervention | null {
  return decide(
    makeInput({
      assessment: makeAssessment({ onTask: true, driftSeconds: 0 }),
      goal,
      clutter,
    }),
  )
}

const surveyBase: SurveyDueInput = {
  now: NOW,
  idleSeconds: 0,
  sessionStartedAt: NOW - 600_000,
  lastSurveyAt: null,
  lastSurveyAway: false,
  deskConnected: true,
  policy: DEFAULT_POLICY,
}

test('no desk, no sweep', () => {
  assert.equal(surveyDue({ ...surveyBase, deskConnected: false }), null)
})

test('the gap wins over every other reason, including the floor', () => {
  assert.equal(surveyDue({ ...surveyBase, lastSurveyAt: NOW - 60_000 }), null)
  assert.equal(
    surveyDue({ ...surveyBase, lastSurveyAt: NOW - 60_000, idleSeconds: 3_600 }),
    null,
  )
})

test('a young session sweeps nothing, unless the desk is empty', () => {
  const young = { ...surveyBase, sessionStartedAt: NOW - 60_000 }
  assert.equal(surveyDue(young), null)
  // An empty desk is the one reading worth taking early: it costs no arm time.
  assert.equal(surveyDue({ ...young, idleSeconds: 300 }), 'away')
})

test('the first reading after the start delay is the start one', () => {
  assert.equal(surveyDue(surveyBase), 'start')
  assert.equal(surveyDue({ ...surveyBase, idleSeconds: 300 }), 'start')
})

test('one sweep per absence, then the floor is the slow heartbeat', () => {
  // Just past the gap, and they are gone: this is the away sweep.
  assert.equal(surveyDue({ ...surveyBase, lastSurveyAt: NOW - 400_000, idleSeconds: 300 }), 'away')
  // The same absence continues: no second sweep for it.
  assert.equal(
    surveyDue({
      ...surveyBase,
      lastSurveyAt: NOW - 400_000,
      lastSurveyAway: true,
      idleSeconds: 300,
    }),
    null,
  )
  // Present, past the gap, and the floor has not come round yet.
  assert.equal(surveyDue({ ...surveyBase, lastSurveyAt: NOW - 400_000 }), null)
  // Present, and the floor has come round.
  assert.equal(surveyDue({ ...surveyBase, lastSurveyAt: NOW - 1_300_000 }), 'floor')
})

test('a fresh cluttered reading on an on-task window is the desk line', () => {
  const result = withClutter(makeClutter())
  assert.equal(result?.tier, 3)
  assert.equal(result?.channel, 'speech')
  assert.equal(result?.message, 'Paper has taken over the desk. Clear the pile and get back to it.')
  assert.equal(result?.reason, 'tier3:speak:clutter:papers')
  assert.equal(result?.point, null)
  assert.equal(result?.reversible, false)
})

test('the desk line points at the worst hotspot only when the goal grants it', () => {
  const reading = makeReading({
    hotspots: [{ poseIndex: 1, label: 'cups', severity: 0.8, at: { x: 0.2, y: 0.3 } }],
    evidence: ['four cups along the back edge'],
  })
  const poses = [{ aim: null }, { aim: { x: 120, y: 60 } }]
  const granting = speakingGoal(['nudge', 'speak', 'automate'])

  const pointed = withClutter(makeClutter({ reading, poses }), granting)
  assert.equal(pointed?.tier, 3)
  assert.deepEqual(pointed?.point, { x: 120, y: 60 })
  assert.equal(pointed?.message, 'The cups have piled up. Take them out and settle back in.')
  assert.equal(pointed?.reason, 'tier3:speak:clutter:cups')

  // A session that has already gestured at the desk speaks without pointing again.
  const already = withClutter(makeClutter({ reading, poses, pointedThisSession: true }), granting)
  assert.equal(already?.tier, 3)
  assert.equal(already?.point, null)

  // No calibration: the sweep has no desk millimetres to aim at.
  const uncalibrated = withClutter(
    makeClutter({ reading, poses: [{ aim: null }, { aim: null }] }),
    granting,
  )
  assert.equal(uncalibrated?.point, null)

  // The goal does not grant the gesture, so the line is spoken and nothing moves.
  const denied = withClutter(makeClutter({ reading, poses }))
  assert.equal(denied?.tier, 3)
  assert.equal(denied?.point, null)
})

test('a reading with no hotspot still gets the plain line', () => {
  const result = withClutter(makeClutter({ reading: makeReading({ hotspots: [] }), poses: [] }))
  assert.equal(result?.message, 'The desk has filled up. Clear it and get back to it.')
  assert.equal(result?.reason, 'tier3:speak:clutter')
  assert.equal(result?.point, null)
})

test('doubt, age, a low score and no rise are all silence', () => {
  assert.equal(withClutter(makeClutter({ reading: makeReading({ confidence: 0.5 }) })), null)
  assert.equal(withClutter(makeClutter({ at: NOW - 700_000 })), null)
  assert.equal(withClutter(makeClutter({ reading: makeReading({ score: 0.4 }) })), null)
  // 0.85 is not 0.25 worse than the 0.7 it last spoke about — and 0.85 is a real
  // reading of the same desk, not a guess: the bar clears the spread measured on
  // the bench (0.32 and 0.45 for one unchanged desk), so only a real change speaks.
  assert.equal(withClutter(makeClutter({ reading: makeReading({ score: 0.85 }), lastSpokenScore: 0.7 })), null)
  const risen = withClutter(makeClutter({ reading: makeReading({ score: 0.95 }), lastSpokenScore: 0.7 }))
  assert.equal(risen?.tier, 3)
  assert.equal(risen?.reason, 'tier3:speak:clutter:papers')
})

test('a goal that may not speak is never given a desk line', () => {
  assert.equal(
    withClutter(makeClutter(), makeGoal({ permissions: ['nudge'] satisfies GoalType['permissions'] })),
    null,
  )
  assert.equal(
    withClutter(makeClutter(), makeGoal({ policy: { ...DEFAULT_POLICY, maxTier: 2 } })),
    null,
  )
})

test('the speech gap and the slower desk gap both hold a desk line back', () => {
  // Inside the speech channel's own gap.
  assert.equal(withClutter(makeClutter({ lastSpokenAt: NOW - 10_000 })), null)
  // Past the speech gap, risen above the last line, and still inside the desk gap.
  assert.equal(
    withClutter(makeClutter({ lastSpokenScore: 0.5, lastSpokenAt: NOW - 200_000 })),
    null,
  )
  // Past both gaps, and risen: the line comes out.
  const due = withClutter(makeClutter({ lastSpokenScore: 0.5, lastSpokenAt: NOW - 2_800_000 }))
  assert.equal(due?.tier, 3)
})
