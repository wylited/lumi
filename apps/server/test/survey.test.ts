import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { test } from 'node:test'

import {
  Assessment,
  ClutterReading,
  DEFAULT_POLICY,
  DeskActionResult,
  Goal,
  Observation,
} from '@heli/contracts'
import type {
  DeskActionRecord,
  DeskSurveyPose,
  Goal as GoalType,
  Intervention,
  LiveEvent,
  Outcome,
  Policy,
  SignalWindow,
} from '@heli/contracts'

import { createLoop, type Loop } from '../src/observe/index.js'
import { inMemoryTransport } from '../src/voice/transport.js'
import type {
  AssessFrame,
  DeskIssuer,
  ObservationWriter,
  SessionReader,
  SpeechProvider,
  SurveyInput,
  VisionProvider,
} from '../src/observe/types.js'

/**
 * The survey pass, end to end with the seams faked: a scripted rig, a scripted
 * model, and an in-memory reader and writer. The loop, the policy and the pass
 * are the real thing — which is what makes this the proof that a sweep becomes
 * one row and, when the desk is bad enough, one line.
 */

const NOW = 1_800_000_000_000

function makeWindow(overrides: Partial<SignalWindow> = {}): SignalWindow {
  return {
    from: new Date(NOW - 60_000).toISOString(),
    to: new Date(NOW).toISOString(),
    windowMs: 60_000,
    focusedSeconds: 55,
    offTaskSeconds: 0,
    idleSeconds: 0,
    contextSwitches: 1,
    longestFocusRunSeconds: 55,
    inputRate: 2,
    onTaskRatio: 1,
    topApps: [],
    topSites: [],
    focusMode: false,
    lastFrameRef: 'frame-1',
    lastScreenRef: null,
    ...overrides,
  }
}

/** The window the tick would see at `at`, one minute wide. */
function windowAt(at: number): SignalWindow {
  return makeWindow({
    from: new Date(at - 60_000).toISOString(),
    to: new Date(at).toISOString(),
  })
}

function makeGoal(overrides: Partial<GoalType> = {}): GoalType {
  return Goal.parse({
    id: 'goal_1',
    kind: 'study',
    objective: 'Finish the physics problem set',
    successCriteria: null,
    timeBudgetMinutes: 60,
    permissions: ['nudge', 'speak', 'automate'],
    automations: [],
    policy: { ...DEFAULT_POLICY, maxTier: 3 },
    active: true,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  })
}

function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    onTask: true,
    activity: 'working',
    kind: null,
    driftSeconds: 0,
    evidence: ['typing in the editor'],
    confidence: 0.9,
    because: 'the editor has focus',
    ...overrides,
  }
}

function makeReading(overrides: Partial<ClutterReading> = {}): ClutterReading {
  return ClutterReading.parse({
    score: 0.8,
    hotspots: [{ poseIndex: 1, label: 'papers', severity: 0.9, at: { x: 0.4, y: 0.5 } }],
    evidence: ['a stack of paper across the middle of the desk'],
    confidence: 0.9,
    because: 'paper across the middle',
    ...overrides,
  })
}

/** One pose of a sweep, as the rig reports it. */
function pose(index: number, seq: number, aim: { x: number; y: number } | null = null): DeskSurveyPose {
  return { index, seq, pose: { pan: 1, tilt: 2 }, aim }
}

interface IssuedAction {
  deskId: string
  request: { type: string; payload: Record<string, unknown> }
}

interface ScriptedDesk extends DeskIssuer {
  issued: IssuedAction[]
}

/**
 * The rig, scripted. `poses` is what its ack reports, so the test can prove the
 * frames are read by the seqs the ack named rather than by whatever is newest.
 */
function scriptedDesk(
  options: {
    poses?: DeskSurveyPose[]
    status?: 'done' | 'failed'
    error?: string | null
    connected?: boolean
    hasArm?: boolean
  } = {},
): ScriptedDesk {
  const poses = options.poses ?? [pose(0, 10), pose(1, 11), pose(2, 12)]
  const issued: IssuedAction[] = []

  return {
    issued,
    async theDesk() {
      if (options.connected === false) return null
      return { id: 'desk_1', connected: options.connected ?? true, hasArm: options.hasArm ?? true }
    },
    async issue(deskId, request): Promise<DeskActionRecord> {
      issued.push({ deskId, request })
      const status = options.status ?? 'done'
      return {
        id: `act_${issued.length}`,
        type: request.type,
        status,
        issuedAt: new Date(NOW).toISOString(),
        completedAt: new Date(NOW).toISOString(),
        result:
          status === 'done'
            ? DeskActionResult.parse({
                survey: {
                  reason: String(request.payload.reason ?? ''),
                  startedAt: new Date(NOW).toISOString(),
                  durationMs: 4_200,
                  poses,
                },
              })
            : null,
        error: options.error ?? null,
      }
    },
  }
}

interface FakeReader extends SessionReader {
  surveyCalls: { sessionId: string; seqs: number[] }[]
  /** The window the reader answers with, so a test can move the tick along. */
  setWindow(next: SignalWindow | null): void
}

function fakeReader(
  input: {
    window?: SignalWindow | null
    goal?: GoalType | null
    startedAt?: number | null
    policy?: Policy
  } = {},
): FakeReader {
  let window = input.window === undefined ? makeWindow() : input.window
  const goal = input.goal === undefined ? makeGoal() : input.goal
  const surveyCalls: { sessionId: string; seqs: number[] }[] = []

  return {
    surveyCalls,
    setWindow(next) {
      window = next
    },
    async window() {
      return window
    },
    async frames() {
      return []
    },
    async goalFor() {
      return goal
    },
    async policyFor() {
      return input.policy ?? goal?.policy ?? DEFAULT_POLICY
    },
    async sessionStartedAt() {
      return input.startedAt === undefined ? NOW - 600_000 : input.startedAt
    },
    // One frame per seq the ack named, in that order: exactly what the Prisma
    // reader does with the ring, minus the ring.
    async surveyFrames(sessionId, seqs) {
      surveyCalls.push({ sessionId, seqs })
      return seqs.map(
        (seq): AssessFrame => ({
          kind: 'desk',
          ref: `survey/${seq}.jpg`,
          mediaType: 'image/jpeg',
          bytes: Buffer.from([seq]),
          width: 640,
          height: 480,
        }),
      )
    },
  }
}

interface FakeWriter extends ObservationWriter {
  rows: Observation[]
}

function fakeWriter(): FakeWriter {
  const rows: Observation[] = []
  let n = 0

  const writer: FakeWriter = {
    rows,
    async write(input) {
      n += 1
      const row = Observation.parse({
        id: `obs_${n}`,
        sessionId: input.sessionId,
        ts: new Date(NOW).toISOString(),
        signals: input.window,
        assessment: input.assessment,
        survey: input.survey ?? null,
        tier: input.tier,
        action: (input.action as Intervention | null) ?? null,
        outcome: input.outcome as Outcome | null,
        confidence: input.confidence,
        reason: input.reason,
        latencyMs: input.latencyMs,
      })
      rows.push(row)
      return row
    },
    async markOutcome() {},
    async recentOutcomes() {
      return []
    },
    async lastSpokenAt() {
      return null
    },
    async lastNudgeAt() {
      return null
    },
    async consecutiveOffGoal() {
      return 0
    },
  }

  return writer
}

interface FakeVision extends VisionProvider {
  calls: { assess: number; survey: SurveyInput[] }
}

function fakeVision(
  options: { reading?: ClutterReading; assessment?: Assessment } = {},
): FakeVision {
  const calls = { assess: 0, survey: [] as SurveyInput[] }

  return {
    name: 'local',
    calls,
    async assess() {
      calls.assess += 1
      if (!options.assessment) throw new Error('the test scripted no assessment')
      return options.assessment
    },
    async survey(input) {
      calls.survey.push(input)
      return options.reading ?? makeReading()
    },
  }
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

interface Harness {
  loop: Loop
  writer: FakeWriter
  reader: FakeReader
  desk: ScriptedDesk
  vision: FakeVision
  events: LiveEvent[]
  /**
   * The loop's clock, mutable: the desk line's two brakes are gaps measured from
   * the *last line*, which only real state can express — a stubbed writer cannot.
   */
  clock: { now(): number; setNow(at: number): void; advance(ms: number): void }
}

function harness(
  options: {
    desk?: ScriptedDesk
    vision?: FakeVision
    reader?: Parameters<typeof fakeReader>[0]
  } = {},
): Harness {
  const writer = fakeWriter()
  const reader = fakeReader(options.reader)
  const desk = options.desk ?? scriptedDesk()
  const vision = options.vision ?? fakeVision()
  const events: LiveEvent[] = []

  let now = NOW
  const clock = {
    now: () => now,
    setNow(at: number) {
      now = at
    },
    advance(ms: number) {
      now += ms
    },
  }

  const loop = createLoop(
    {
      clock,
      bus: { publish: (_sessionId, event) => events.push(event) },
      transport: inMemoryTransport(),
      vision,
      speech: silentSpeech(),
      reader,
      writer,
      desk,
      logger: { info() {}, warn() {}, error() {} },
    },
    { budgetMs: 4000, historyLimit: 20 },
  )

  return { loop, writer, reader, desk, vision, events, clock }
}

test('a done sweep reads the frames it named, writes one survey row and keeps the reading', async () => {
  const poses = [pose(0, 10), pose(1, 11), pose(2, 12)]
  const h = harness({ desk: scriptedDesk({ poses }) })

  const attempt = await h.loop.runSurvey('sess', 'manual')
  assert.ok(attempt.ok, 'the sweep read the desk')

  // The action went out once, as a sweep of three poses, and says who asked.
  assert.equal(h.desk.issued.length, 1)
  assert.equal(h.desk.issued[0]?.request.type, 'desk.survey')
  assert.deepEqual(h.desk.issued[0]?.request.payload, { reason: 'survey:manual', poses: 3 })

  // The frames are the ones the ack named, in the ack's order.
  assert.deepEqual(h.reader.surveyCalls, [{ sessionId: 'sess', seqs: [10, 11, 12] }])
  assert.equal(h.vision.calls.survey.length, 1, 'one sweep is one model call')
  assert.equal(h.vision.calls.assess, 0, 'a sweep never runs the window assessment')
  // The model is asked about the goal in the person's own words, on this window.
  assert.equal(h.vision.calls.survey[0]?.goal.objective, 'Finish the physics problem set')
  assert.equal(h.vision.calls.survey[0]?.window.to, makeWindow().to)
  assert.deepEqual(
    h.vision.calls.survey[0]?.frames.map((frame) => frame.ref),
    ['survey/10.jpg', 'survey/11.jpg', 'survey/12.jpg'],
  )
  assert.deepEqual(attempt.poses.map((p) => p.seq), [10, 11, 12])

  // One row, and it is a survey row: no assessment, tier 0, the reading on it.
  assert.equal(h.writer.rows.length, 1)
  const row = h.writer.rows[0]
  assert.equal(row?.assessment, null)
  assert.equal(row?.tier, 0)
  assert.equal(row?.survey?.score, 0.8)
  assert.equal(row?.reason, 'survey:clutter:0.80')
  assert.equal(row?.confidence, 0.9)

  // The reading is published for SSE, exactly like a window's row.
  assert.deepEqual(
    h.events.map((event) => event.event),
    ['observation'],
  )
})

test('a sweep the rig refused costs no model call and writes no row', async () => {
  const h = harness({
    desk: scriptedDesk({ status: 'failed', error: 'survey_unavailable' }),
  })

  const attempt = await h.loop.runSurvey('sess', 'manual')

  // The rig's own word is what the caller hears, so the panel can say why.
  assert.deepEqual(attempt, { ok: false, reason: 'survey_unavailable' })
  assert.equal(h.vision.calls.survey.length, 0)
  assert.equal(h.reader.surveyCalls.length, 0)
  assert.equal(h.writer.rows.length, 0)
})

test('a second sweep inside the gap is refused before the rig is ever asked', async () => {
  const h = harness()

  const first = await h.loop.runSurvey('sess', 'manual')
  assert.ok(first.ok)

  const second = await h.loop.runSurvey('sess', 'manual')
  assert.deepEqual(second, { ok: false, reason: 'gap' })
  assert.equal(h.desk.issued.length, 1, 'the gap stopped the second action at the source')
  assert.equal(h.vision.calls.survey.length, 1)
})

test('a desk that is not there is refused without an action', async () => {
  const h = harness({ desk: scriptedDesk({ connected: false }) })

  assert.deepEqual(await h.loop.runSurvey('sess', 'manual'), { ok: false, reason: 'no_desk' })
  assert.equal(h.desk.issued.length, 0)
  assert.equal(h.writer.rows.length, 0)
})

test('a sweep whose frames never landed writes nothing', async () => {
  // A `done` ack that reports no poses at all: the rig answered, and there was
  // nothing in it.
  const h = harness({ desk: scriptedDesk({ poses: [] }) })

  assert.deepEqual(await h.loop.runSurvey('sess', 'manual'), { ok: false, reason: 'no_frames' })
  assert.equal(h.vision.calls.survey.length, 0)
  assert.equal(h.writer.rows.length, 0)
})

test('a fresh reading and an on-task window produce the desk line and one point', async () => {
  // The reading's worst hotspot is in the second frame, so that is the pose the
  // point has to come from.
  const poses = [pose(0, 10), pose(1, 11, { x: 120, y: 60 }), pose(2, 12)]
  const h = harness({
    desk: scriptedDesk({ poses }),
    vision: fakeVision({ assessment: makeAssessment(), reading: makeReading() }),
  })

  const sweep = await h.loop.runSurvey('sess', 'manual')
  assert.ok(sweep.ok)

  const result = await h.loop.runWindow('sess')
  assert.ok(result, 'the window was assessed')
  assert.equal(result.tier, 3, 'a cluttered desk speaks to a person who is on task')
  assert.equal(
    result.intervention?.message,
    'Paper has taken over the desk. Clear the pile and get back to it.',
  )
  assert.equal(result.intervention?.reason, 'tier3:speak:clutter:papers')
  assert.deepEqual(result.intervention?.point, { x: 120, y: 60 })

  // The gesture is issued detached, so it lands after the row is written.
  await tick()
  const points = h.desk.issued.filter((action) => action.request.type === 'arm.point')
  assert.equal(points.length, 1)
  assert.deepEqual(points[0]?.request.payload, { x: 120, y: 60 })
})

test('the same reading does not speak twice', async () => {
  const poses = [pose(0, 10), pose(1, 11, { x: 120, y: 60 })]
  const h = harness({
    desk: scriptedDesk({ poses }),
    vision: fakeVision({ assessment: makeAssessment(), reading: makeReading() }),
  })

  assert.ok((await h.loop.runSurvey('sess', 'manual')).ok)

  const first = await h.loop.runWindow('sess')
  assert.equal(first?.tier, 3, 'a cluttered desk speaks to a person who is on task')
  assert.match(first?.intervention?.reason ?? '', /^tier3:speak:clutter/)

  // A minute later the person is still on task and the desk is unchanged, so the
  // reading is still fresh. Only the two brakes on the last desk line can keep
  // the line from repeating, and this is where the loop has to remember it.
  h.clock.advance(60_000)
  h.reader.setWindow(windowAt(h.clock.now()))
  const second = await h.loop.runWindow('sess')
  assert.equal(second?.tier, 0, 'the same reading is not said again')
  assert.equal(second?.intervention, null)
  assert.equal(second?.reason, 'tier0:silent')
  assert.equal(
    h.writer.rows.filter((row) => row.tier === 3).length,
    1,
    'the desk line goes out once, not once per window',
  )
})

test('a later line speaks again, and does not point again', async () => {
  const poses = [pose(0, 10), pose(1, 11, { x: 120, y: 60 })]
  const h = harness({
    desk: scriptedDesk({ poses }),
    // The first reading is under the risen bar the second one has to clear.
    vision: fakeVision({ assessment: makeAssessment(), reading: makeReading({ score: 0.7 }) }),
  })

  assert.ok((await h.loop.runSurvey('sess', 'manual')).ok)

  const first = await h.loop.runWindow('sess')
  assert.equal(first?.tier, 3)
  await tick()
  assert.deepEqual(first?.intervention?.point, { x: 120, y: 60 })

  // The desk got worse while the gaps passed: past the clutter gap (45 min), the
  // desk is read again and the reading has risen by `clutterRiseDelta`. Both
  // brakes are the *last line*, so a second line needs a new sweep, not a new
  // window — the memory is the line's, not the reading's.
  h.clock.advance(3_000_000)
  const risen = makeReading({
    score: 0.95,
    hotspots: [{ poseIndex: 1, label: 'cups', severity: 0.9, at: { x: 0.4, y: 0.5 } }],
  })
  h.vision.survey = async (input) => {
    h.vision.calls.survey.push(input)
    return risen
  }
  assert.ok((await h.loop.runSurvey('sess', 'manual')).ok)

  // The next window is a different one, and the desk is worse than the last line
  // said: the line comes back, naming what is worst now.
  h.clock.advance(60_000)
  h.reader.setWindow(windowAt(h.clock.now()))
  const second = await h.loop.runWindow('sess')
  assert.equal(second?.tier, 3, 'the desk line comes back once both gaps have passed')
  assert.equal(second?.intervention?.reason, 'tier3:speak:clutter:cups')
  assert.equal(second?.intervention?.point, null, 'the gesture is once a session')
  await tick()

  assert.equal(
    h.desk.issued.filter((action) => action.request.type === 'arm.point').length,
    1,
    'the session points at the desk once',
  )
})

test('a reading the model will not hold to the contract is no reading', async () => {
  const h = harness()

  // Prose instead of a reading: the pass holds the answer to `ClutterReading`.
  h.vision.survey = async () => 'the desk is quite cluttered' as unknown as ClutterReading
  assert.deepEqual(await h.loop.runSurvey('sess', 'manual'), {
    ok: false,
    reason: 'assess_failed',
  })
  assert.equal(h.writer.rows.length, 0)

  // A provider that throws is the same thing: no reading, and no row.
  const down = harness()
  down.vision.survey = async () => {
    throw new Error('the model is down')
  }
  assert.deepEqual(await down.loop.runSurvey('sess', 'manual'), {
    ok: false,
    reason: 'assess_failed',
  })
  assert.equal(down.writer.rows.length, 0)
})

test('a sweep that was refused still spends the gap', async () => {
  // The gap binds attempts, not successes. Keyed on a reading, a rig that refuses
  // every sweep leaves `lastSurveyAt` untouched and `surveyDue` reads a session
  // that has never been read as due for a `start` sweep on *every* window — 20 s
  // of arm time and a model call per tick, forever.
  const cases: Array<[string, ScriptedDesk, string]> = [
    ['the rig refused', scriptedDesk({ status: 'failed', error: 'survey_timeout' }), 'survey_timeout'],
    ['the ack named no frames', scriptedDesk({ poses: [] }), 'no_frames'],
    ['the model threw', scriptedDesk(), 'assess_failed'],
  ]

  for (const [label, desk, reason] of cases) {
    const h = harness({ desk })
    if (reason === 'assess_failed') {
      h.vision.survey = async () => {
        throw new Error('the model is down')
      }
    }

    // No trigger: the due table decides, and a session ten minutes old wants the
    // `start` sweep.
    assert.deepEqual(await h.loop.runSurvey('sess'), { ok: false, reason }, label)
    // The next window is inside the gap, so the rig is not asked again.
    assert.deepEqual(await h.loop.runSurvey('sess'), { ok: false, reason: 'gap' }, label)
    assert.equal(desk.issued.length, 1, label)
  }
})

test('a second absence earns its own sweep', async () => {
  const h = harness({
    vision: fakeVision({ assessment: makeAssessment() }),
    // A minute into the session, so the only sweep the due table will name is the
    // away one.
    reader: { startedAt: NOW - 60_000 },
  })

  // Nobody there: the away sweep, and it is the first the session has taken.
  h.reader.setWindow(makeWindow({ idleSeconds: 300 }))
  const away = await h.loop.runSurvey('sess')
  assert.ok(away.ok)
  assert.equal(h.desk.issued[0]?.request.payload.reason, 'survey:away')
  assert.equal(h.desk.issued.length, 1)

  // A window that finds them back. The absence is over, so the latch has to
  // clear or the next one never earns a sweep.
  h.clock.setNow(NOW + 300_000)
  h.reader.setWindow(
    makeWindow({ idleSeconds: 0, to: new Date(h.clock.now()).toISOString() }),
  )
  await h.loop.runWindow('sess')

  // They leave again, past the gap: a second absence, a second sweep.
  h.clock.setNow(NOW + 900_000)
  h.reader.setWindow(
    makeWindow({ idleSeconds: 400, to: new Date(h.clock.now()).toISOString() }),
  )
  const again = await h.loop.runSurvey('sess')
  assert.ok(again.ok, 'the second absence is swept')
  assert.equal(h.desk.issued.length, 2)
  assert.equal(h.desk.issued[1]?.request.payload.reason, 'survey:away')
})
