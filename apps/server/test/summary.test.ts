import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSummary, type SummaryInput } from '../src/observe/summary.js'

type Observation = SummaryInput['observations'][number]

const base = (): Omit<SummaryInput, 'observations'> => ({
  goal: { objective: 'finish the linear algebra set', timeBudgetMinutes: 60 },
  session: { startedAt: 1_700_000_000_000, endedAt: 1_700_003_600_000 },
})

const obs = (partial: {
  focusedSeconds?: number
  offTaskSeconds?: number
  longestFocusRunSeconds?: number
  contextSwitches?: number
  tier?: number
  outcome?: string | null
  kind?: string | null
  topApps?: { app: string; seconds: number; onTask: boolean }[]
}): Observation => ({
  ts: 0,
  tier: partial.tier ?? 0,
  outcome: partial.outcome ?? null,
  reason: null,
  confidence: 0.9,
  window: {
    focusedSeconds: partial.focusedSeconds ?? 0,
    offTaskSeconds: partial.offTaskSeconds ?? 0,
    contextSwitches: partial.contextSwitches ?? 0,
    longestFocusRunSeconds: partial.longestFocusRunSeconds ?? 0,
    topApps: partial.topApps ?? [],
  },
  assessment:
    partial.kind === undefined ? null : { kind: partial.kind ?? null, activity: 'browsing' },
})

test('arithmetic matches a hand-built fixture', () => {
  const summary = buildSummary({
    ...base(),
    observations: [
      obs({ focusedSeconds: 2460, longestFocusRunSeconds: 1800 }),
      obs({ focusedSeconds: 900, offTaskSeconds: 420, longestFocusRunSeconds: 1200, tier: 2, outcome: 'resolved' }),
    ],
  })

  assert.equal(summary.focusedMinutes, 56)
  assert.equal(summary.offTaskMinutes, 7)
  assert.equal(summary.longestFocusRunSeconds, 1800)
})

test('topDistraction is the off-task app with the most seconds', () => {
  const summary = buildSummary({
    ...base(),
    observations: [
      obs({
        offTaskSeconds: 420,
        topApps: [
          { app: 'youtube', seconds: 300, onTask: false },
          { app: 'slack', seconds: 120, onTask: false },
        ],
      }),
      obs({
        offTaskSeconds: 450,
        topApps: [
          { app: 'youtube', seconds: 200, onTask: false },
          { app: 'reddit', seconds: 250, onTask: false },
        ],
      }),
    ],
  })

  assert.equal(summary.topDistraction, 'youtube')
})

test('whatWorked keeps only resolved outcomes and drops ignored and unknown', () => {
  const summary = buildSummary({
    ...base(),
    observations: [
      obs({ tier: 2, outcome: 'resolved' }),
      obs({ tier: 2, outcome: 'ignored' }),
      obs({ tier: 3, outcome: 'resolved' }),
      obs({ tier: 3, outcome: 'unknown' }),
      obs({ tier: 3, outcome: 'reverted' }),
    ],
  })

  assert.deepEqual(summary.worked, [
    { tier: 2, outcome: 'resolved', count: 1 },
    { tier: 3, outcome: 'resolved', count: 1 },
  ])
  assert.ok(summary.worked.every((entry) => entry.outcome === 'resolved'))
  assert.match(summary.message, /resolved 1 of 5 interventions/)
})

test('headline contains a real number and the goal wording, without praise', () => {
  const summary = buildSummary({
    ...base(),
    observations: [
      obs({ focusedSeconds: 2460, longestFocusRunSeconds: 1800, tier: 2, outcome: 'resolved' }),
      obs({ focusedSeconds: 420, offTaskSeconds: 300 }),
    ],
  })

  assert.match(summary.message, /\d/)
  assert.match(summary.message, /48 focused minutes/)
  assert.match(summary.message, /finish the linear algebra set/)
  assert.doesNotMatch(summary.message, /!/)
})

test('a session with no interventions gets an honest headline', () => {
  const summary = buildSummary({
    ...base(),
    observations: [
      obs({ focusedSeconds: 600, offTaskSeconds: 1200 }),
      obs({ focusedSeconds: 300, offTaskSeconds: 600 }),
    ],
  })

  assert.equal(summary.worked.length, 0)
  assert.match(summary.message, /no interventions fired/)
  assert.match(summary.message, /only 15 focused minutes/)
  assert.match(summary.message, /30 off task/)
})

test('a session with zero observations does not throw', () => {
  const summary = buildSummary({ ...base(), observations: [] })

  assert.equal(summary.focusedMinutes, 0)
  assert.equal(summary.offTaskMinutes, 0)
  assert.equal(summary.longestFocusRunSeconds, 0)
  assert.equal(summary.topDistraction, null)
  assert.deepEqual(summary.worked, [])
  assert.match(summary.message, /No observations were recorded/)
})
