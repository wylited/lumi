import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Assessment,
  DEFAULT_POLICY,
  Goal,
  Observation,
  type Goal as GoalType,
  type Intervention,
  type LiveEvent,
  type Outcome,
  type SignalWindow,
} from '@heli/contracts'

import { createLoop } from '../src/observe/index.js'
import { inMemoryTransport, type InMemoryTransport } from '../src/voice/transport.js'
import type {
  ObservationWriter,
  SessionReader,
  SpeechProvider,
  VisionProvider,
} from '../src/observe/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

interface Expectation {
  onTrack: boolean
  kind: string | null
  expectedTier: number
  note: string
}
const expected = JSON.parse(
  readFileSync(join(fixtures, 'expected.json'), 'utf8'),
) as Record<string, Expectation>

interface Fixture {
  id: string
  note: string
  window: SignalWindow
  goalKind: string
}
const load = (id: string): Fixture =>
  JSON.parse(readFileSync(join(fixtures, 'windows', `${id}.json`), 'utf8')) as Fixture

const LOW_CONFIDENCE = new Set(['second-person', 'dark-room', 'blurry-low-info'])
const ACTIVITY: Record<string, string> = {
  'away-idle': 'away',
  'reading-low-input': 'reading',
  'phone-in-hand': 'phone',
}

/**
 * The model is scripted from the fixtures; the policy and the orchestrator are
 * the real thing. That is the point of a harness: fake the model, test the rules.
 */
function scriptedVision(): VisionProvider {
  return {
    name: 'local',
    async assess(input: Parameters<VisionProvider['assess']>[0]): Promise<Assessment> {
      const id = input.window.lastFrameRef ?? ''
      const want = expected[id]
      if (!want) throw new Error(`no expectation for fixture ${id}`)
      return Assessment.parse({
        onTask: want.onTrack,
        activity: ACTIVITY[id] ?? (want.onTrack ? 'working' : 'idle'),
        kind: want.kind,
        driftSeconds: input.window.offTaskSeconds,
        evidence: [
          `onTaskRatio=${input.window.onTaskRatio}`,
          `drift=${input.window.offTaskSeconds}s`,
        ],
        confidence: LOW_CONFIDENCE.has(id) ? 0.5 : 0.8,
        because: `fixture ${id}`,
      })
    },
  }
}

interface SeedRow {
  tier: number
  kind: string | null
  outcome: Outcome
  at: number
  /** Defaults to false: a seeded intervention implies the window was off task. */
  onTask?: boolean
}

class FakeWriter implements ObservationWriter {
  rows: (Observation & { kind: string | null; at: number })[] = []
  private n = 0

  seed(rows: SeedRow[]): void {
    for (const row of rows) {
      this.n += 1
      this.rows.push({
        ...Observation.parse({
          id: `seed_${this.n}`,
          sessionId: 'sess',
          ts: new Date(row.at).toISOString(),
          signals: {
            from: '',
            to: '',
            windowMs: 0,
            focusedSeconds: 0,
            offTaskSeconds: 0,
            idleSeconds: 0,
            contextSwitches: 0,
            longestFocusRunSeconds: 0,
            inputRate: 0,
            onTaskRatio: 0,
            topApps: [],
            topSites: [],
            focusMode: false,
            lastFrameRef: null,
            lastScreenRef: null,
          },
          assessment: Assessment.parse({
            onTask: row.onTask ?? false,
            activity: 'idle',
            kind: row.kind,
            driftSeconds: 60,
            evidence: ['seed'],
            confidence: 0.8,
            because: 'seed',
          }),
          tier: row.tier,
          action: null,
          outcome: row.outcome,
          confidence: null,
          reason: 'seed',
          latencyMs: 0,
        }),
        kind: row.kind,
        at: row.at,
      })
    }
  }

  async write(input: Parameters<ObservationWriter['write']>[0]): Promise<Observation> {
    this.n += 1
    const at = Date.now()
    const row = Observation.parse({
      id: `obs_${String(this.n).padStart(3, '0')}`,
      sessionId: input.sessionId,
      ts: new Date(at).toISOString(),
      signals: input.window,
      assessment: input.assessment,
      tier: input.tier,
      action: input.action as Intervention | null,
      outcome: input.outcome,
      confidence: input.confidence,
      reason: input.reason,
      latencyMs: input.latencyMs,
    })
    this.rows.push({ ...row, kind: input.assessment?.kind ?? null, at })
    return row
  }

  async markOutcome(observationId: string, outcome: Outcome): Promise<void> {
    const row = this.rows.find((r) => r.id === observationId)
    if (row) row.outcome = outcome
  }

  async recentOutcomes(_sessionId: string, limit: number) {
    return this.rows
      .filter((r) => r.tier > 0)
      .slice(-limit)
      .reverse()
      .map((r) => ({ tier: r.tier, kind: r.kind, outcome: r.outcome ?? 'unknown' }))
  }

  async lastSpokenAt(): Promise<number | null> {
    const row = [...this.rows].reverse().find((r) => r.tier === 3)
    return row ? row.at : null
  }

  async lastNudgeAt(): Promise<number | null> {
    const row = [...this.rows].reverse().find((r) => r.tier === 2)
    return row ? row.at : null
  }

  async consecutiveOffGoal(): Promise<number> {
    let count = 0
    for (const row of [...this.rows].reverse()) {
      if (row.assessment && row.assessment.onTask === false) count += 1
      else break
    }
    return count
  }
}

type Reader = SessionReader & {
  setWindow(w: SignalWindow): void
  setGoal(g: GoalType): void
}

/** `window` is both state and a method name on the interface, so state is closed over. */
function makeReader(): Reader {
  const state = { window: null as SignalWindow | null, goal: null as GoalType | null }
  return {
    setWindow(w) {
      state.window = w
    },
    setGoal(g) {
      state.goal = g
    },
    async window() {
      return state.window
    },
    async frames() {
      return []
    },
    async goalFor() {
      return state.goal
    },
    async policyFor() {
      return state.goal?.policy ?? DEFAULT_POLICY
    },
  } as Reader
}

function fixtureGoal(): GoalType {
  return Goal.parse({
    id: 'goal_fixture',
    kind: 'study',
    objective: 'Finish the linear algebra problem set',
    successCriteria: 'all problems attempted',
    timeBudgetMinutes: 120,
    breakPolicy: 'pomodoro_25_5',
    permissions: ['nudge', 'speak'],
    automations: [],
    policy: { ...DEFAULT_POLICY, maxTier: 3 },
    active: true,
    createdAt: new Date().toISOString(),
  })
}

interface Harness {
  loop: ReturnType<typeof createLoop>
  writer: FakeWriter
  reader: Reader
  transport: InMemoryTransport
  events: LiveEvent[]
  clock: { now: () => number }
}

/** The voice is not under test: a line comes back as 200 ms of silence. */
function silentSpeech(): SpeechProvider {
  return {
    name: 'elevenlabs',
    async synthesize() {
      return {
        provider: 'elevenlabs',
        sampleRate: 16_000,
        channels: 1,
        durationMs: 200,
        pcmBase64: Buffer.alloc(6_400).toString('base64'),
      }
    },
  }
}

function harness(budgetMs = 4000): Harness {
  const clock = { now: () => Date.now() }
  const events: LiveEvent[] = []
  const writer = new FakeWriter()
  const reader = makeReader()
  reader.setGoal(fixtureGoal())
  const transport = inMemoryTransport()
  const loop = createLoop(
    {
      clock,
      bus: { publish: (_s, event) => events.push(event) },
      transport,
      speech: silentSpeech(),
      vision: scriptedVision(),
      reader,
      writer,
      logger: { info() {}, warn() {}, error() {} },
    },
    { budgetMs, historyLimit: 20 },
  )
  return { loop, writer, reader, transport, events, clock }
}

/**
 * Each fixture is run against the history its own note assumes: a tier-3
 * expectation needs an unresolved nudge of the same kind behind it, which is
 * what "the nudge was ignored" means.
 */
function seedFor(id: string, want: Expectation, now: number): SeedRow[] {
  const rows: SeedRow[] = []
  if (want.expectedTier >= 2) {
    // One prior off-goal window, so the drift is sustained rather than a blip.
    rows.push({ tier: 0, kind: want.kind, outcome: 'unknown', at: now - 210_000, onTask: false })
  }
  if (want.expectedTier >= 3 && want.kind) {
    // And an unresolved nudge of the same kind: that is what earns the line.
    rows.push({ tier: 2, kind: want.kind, outcome: 'ignored', at: now - 200_000, onTask: false })
  }
  return rows
}

test('each fixture, with the history its note assumes, gets its expected tier', async () => {
  const results: { id: string; want: number; got: number; ms: number; reason: string | null }[] = []

  for (const id of Object.keys(expected)) {
    const want = expected[id] as Expectation
    const fixture = load(id)
    const now = Date.now()
    const h = harness()
    h.writer.seed(seedFor(id, want, now))
    h.reader.setWindow({
      ...fixture.window,
      from: new Date(now - fixture.window.windowMs).toISOString(),
      to: new Date(now).toISOString(),
    })

    const started = h.clock.now()
    const result = await h.loop.runWindow('sess')
    assert.ok(result, `${id}: expected a window result`)
    results.push({
      id,
      want: want.expectedTier,
      got: result.tier,
      ms: h.clock.now() - started,
      reason: result.reason,
    })
    assert.equal(
      result.tier,
      want.expectedTier,
      `${id}: expected tier ${want.expectedTier}, got ${result.tier} (${result.reason})`,
    )
  }

  const sorted = results.map((r) => r.ms).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const width = Math.max(...results.map((r) => r.id.length))
  // The harness's whole point is the printed table.
  // eslint-disable-next-line no-console
  console.log(
    `\n${results
      .map((r) => `${r.id.padEnd(width)}  want ${r.want}  got ${r.got}  ${r.ms}ms  ${r.reason ?? ''}`)
      .join('\n')}\nfixtures ${results.length}/${results.length} matched · median ${median}ms\n`,
  )
})

test('the loop is idempotent, judges the previous outcome, and speaks with audio', async () => {
  const h = harness()
  const now = Date.now()
  // A social nudge that was ignored is what earns the spoken line.
  h.writer.seed([{ tier: 2, kind: 'social', outcome: 'ignored', at: now - 200_000 }])

  const social = load('off-task-social-40s')
  h.reader.setWindow({
    ...social.window,
    from: new Date(now - social.window.windowMs).toISOString(),
    to: new Date(now).toISOString(),
  })

  const first = await h.loop.runWindow('sess')
  assert.ok(first)
  assert.equal(first.tier, 3, 'an ignored nudge earns a spoken line')
  assert.ok(h.transport.records.some((r) => r.kind === 'audio.out'), 'audio.out was sent')
  assert.ok(h.transport.records.some((r) => r.kind === 'audio.pcm'), 'tagged audio was sent')

  // The same window is never assessed twice.
  assert.equal(await h.loop.runWindow('sess'), null, 'idempotent per window')

  // The recovery window judges the spoken line as resolved.
  const recovery = load('recovery-after-nudge')
  const later = now + 200_000
  h.reader.setWindow({
    ...recovery.window,
    from: new Date(later - recovery.window.windowMs).toISOString(),
    to: new Date(later).toISOString(),
  })
  const second = await h.loop.runWindow('sess')
  assert.ok(second)
  assert.equal(second.tier, 0)
  const spoken = h.writer.rows.find((r) => r.tier === 3)
  assert.equal(spoken?.outcome, 'resolved', 'the recovery window resolves the spoken line')

  // Every window is persisted, silence included, and published for SSE.
  assert.equal(h.writer.rows.filter((r) => r.reason !== 'seed').length, 2)
  assert.ok(h.events.some((e) => e.event === 'observation'))
  assert.ok(h.events.some((e) => e.event === 'intervention'))
})

test('the loop falls to silence when the vision call exceeds the budget', async () => {
  const now = Date.now()
  const h = harness(60)
  h.reader.setWindow({
    ...load('off-task-video-90s').window,
    from: new Date(now - 600_000).toISOString(),
    to: new Date(now).toISOString(),
  })

  const slow: VisionProvider = {
    name: 'local',
    assess: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              Assessment.parse({
                onTask: false,
                activity: 'idle',
                kind: 'video',
                driftSeconds: 90,
                evidence: [],
                confidence: 0.9,
                because: 'slow',
              }),
            ),
          500,
        ),
      ),
  }

  const loop = createLoop(
    {
      clock: { now: () => Date.now() },
      bus: { publish() {} },
      transport: inMemoryTransport(),
      speech: silentSpeech(),
      vision: slow,
      reader: h.reader,
      writer: h.writer,
      logger: { info() {}, warn() {}, error() {} },
    },
    { budgetMs: 60, historyLimit: 20 },
  )

  const result = await loop.runWindow('sess_budget')
  assert.ok(result)
  assert.equal(result.tier, 0, 'a late assessment is forced to silence')
  assert.equal(result.reason, 'tier0:budget_exceeded')
})
