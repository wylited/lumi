import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_POLICY, Goal } from '@heli/contracts'
import type { Assessment, Goal as GoalType, SignalWindow } from '@heli/contracts'

import { decide, type PolicyInput } from '../src/observe/policy.ts'

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
