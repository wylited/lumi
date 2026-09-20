import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ClutterHotspot, ClutterReading, DEFAULT_POLICY, Goal } from '@heli/contracts'
import type { Goal as GoalType, SignalWindow } from '@heli/contracts'

import {
  buildSurveyMessages,
  createDeepSeekVisionProvider,
  parseClutterContent,
  CLUTTER_JSON_SCHEMA,
  type BuiltRequest,
  type ContentPart,
} from '../src/models/deepseek.js'
import type { AssessFrame, SurveyInput } from '../src/observe/types.js'

const NOW = 1_800_000_000_000

const dataUrl = (text: string): string =>
  `data:image/jpeg;base64,${Buffer.from(text).toString('base64')}`

function makeGoal(): GoalType {
  return Goal.parse({
    id: 'goal-1',
    kind: 'study',
    objective: 'Finish the physics problem set',
    successCriteria: null,
    timeBudgetMinutes: 60,
    policy: DEFAULT_POLICY,
    createdAt: new Date(NOW).toISOString(),
  })
}

function makeWindow(overrides: Partial<SignalWindow> = {}): SignalWindow {
  return {
    from: new Date(NOW - 60_000).toISOString(),
    to: new Date(NOW).toISOString(),
    windowMs: 60_000,
    focusedSeconds: 40,
    offTaskSeconds: 5,
    idleSeconds: 0,
    contextSwitches: 2,
    longestFocusRunSeconds: 30,
    inputRate: 4,
    onTaskRatio: 0.9,
    topApps: [],
    topSites: [],
    focusMode: false,
    lastFrameRef: 'frame-1',
    lastScreenRef: null,
    ...overrides,
  }
}

function makeFrame(index: number, overrides: Partial<AssessFrame> = {}): AssessFrame {
  return {
    kind: 'desk',
    ref: `survey-${index}`,
    mediaType: 'image/jpeg',
    bytes: Buffer.from(`bytes-${index}`),
    width: 640,
    height: 480,
    ...overrides,
  }
}

function makeSurvey(frames: AssessFrame[], window: Partial<SignalWindow> = {}): SurveyInput {
  return { goal: makeGoal(), window: makeWindow(window), frames }
}

/** The survey user turn: the text part, then one part per frame that had bytes. */
function userParts(built: BuiltRequest): ContentPart[] {
  const content = built.messages[1]?.content
  assert.ok(Array.isArray(content), 'the survey turn carries content parts')
  return content
}

test('buildSurveyMessages sends the text part first, then one image per frame in order', () => {
  const built = buildSurveyMessages(makeSurvey([makeFrame(1), makeFrame(2), makeFrame(3)]))
  const [head, ...images] = userParts(built)

  assert.equal(built.imageCount, 3)
  assert.deepEqual(
    userParts(built).map((part) => part.type),
    ['text', 'image_url', 'image_url', 'image_url'],
  )
  assert.deepEqual(
    images.map((part) => (part.type === 'image_url' ? part.image_url.url : '')),
    [dataUrl('bytes-1'), dataUrl('bytes-2'), dataUrl('bytes-3')],
  )

  const text = head?.type === 'text' ? head.text : ''
  assert.match(text, /^Goal: Finish the physics problem set \(study\)\./)
  assert.match(text, /3 images follow, left to right across the desk\. Return one clutter reading\.$/)
})

test('buildSurveyMessages carries the clutter prompt, not the assess one', () => {
  const built = buildSurveyMessages(makeSurvey([makeFrame(1)]))

  const system = built.messages[0]?.content
  assert.equal(typeof system, 'string')
  assert.match(system ?? '', /^# Desk survey/)
  assert.match(system ?? '', /ClutterReading schema/)
  // JSON mode does not enforce a schema, so the vocabulary reaching the model
  // is what the policy later switches on.
  assert.match(system ?? '', /"enum":\["papers","cups","dishes"/)
})

test('CLUTTER_JSON_SCHEMA mirrors the contract field for field', () => {
  assert.deepEqual(Object.keys(CLUTTER_JSON_SCHEMA.properties), Object.keys(ClutterReading.shape))
  assert.deepEqual(CLUTTER_JSON_SCHEMA.required, Object.keys(ClutterReading.shape))
  assert.deepEqual(
    Object.keys(CLUTTER_JSON_SCHEMA.properties.hotspots.items.properties),
    Object.keys(ClutterHotspot.shape),
  )
  assert.deepEqual(
    CLUTTER_JSON_SCHEMA.properties.hotspots.items.required,
    Object.keys(ClutterHotspot.shape),
  )
})

test('buildSurveyMessages skips a frame with no bytes', () => {
  const built = buildSurveyMessages(
    makeSurvey([makeFrame(1), makeFrame(2, { bytes: null }), makeFrame(3)]),
  )
  const [head, ...images] = userParts(built)

  assert.equal(built.imageCount, 2)
  assert.deepEqual(
    images.map((part) => (part.type === 'image_url' ? part.image_url.url : '')),
    [dataUrl('bytes-1'), dataUrl('bytes-3')],
  )
  const text = head?.type === 'text' ? head.text : ''
  assert.match(text, /2 images follow/)
})

test('the survey path never tiles, even a wide frame in a window with sites', () => {
  const wide = { width: 1920, height: 1080 }
  const built = buildSurveyMessages(
    makeSurvey([makeFrame(1, wide), makeFrame(2, wide)], {
      topSites: [{ title: 'docs', seconds: 20, onTask: true }],
    }),
  )

  assert.equal(built.tiled, false)
  assert.equal(built.approximated, false)
  assert.equal(built.imageCount, 2)
  assert.deepEqual(
    userParts(built).map((part) => part.type),
    ['text', 'image_url', 'image_url'],
  )
})

const READING = {
  score: 0.72,
  hotspots: [{ poseIndex: 1, label: 'papers', severity: 0.8, at: { x: 0.4, y: 0.5 } }],
  evidence: ['a stack of paper across the left half'],
  confidence: 0.7,
  because: 'papers across the left of the desk',
}

/** A provider whose every call answers `content`, with the calls and logs kept. */
function stubbedProvider(content: string) {
  const original = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  const infos: { obj: unknown; msg?: string }[] = []
  const warns: { obj: unknown; msg?: string }[] = []

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 7 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  return {
    provider: createDeepSeekVisionProvider({
      apiKey: 'test-key',
      logger: {
        info: (obj, msg) => infos.push({ obj, msg }),
        warn: (obj, msg) => warns.push({ obj, msg }),
        error: () => {},
      },
    }),
    bodies,
    infos,
    warns,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('survey returns the reading and logs vision.survey', async () => {
  const stub = stubbedProvider(JSON.stringify(READING))
  try {
    const reading = await stub.provider.survey(makeSurvey([makeFrame(1), makeFrame(2)]))

    assert.equal(reading.score, 0.72)
    assert.deepEqual(stub.bodies[0]?.response_format, { type: 'json_object' })
    assert.equal(stub.warns.length, 0)
    assert.equal(stub.infos.length, 1)
    assert.equal(stub.infos[0]?.msg, 'vision.survey')

    // The logger takes `unknown`; this test owns what it wrote.
    const logged = stub.infos[0]?.obj as Record<string, unknown>
    assert.equal(logged.provider, 'deepseek')
    assert.equal(logged.model, 'deepseek-flash')
    assert.equal(logged.imageCount, 2)
    assert.equal(logged.score, 0.72)
    assert.equal(logged.hotspots, 1)
    assert.equal(logged.confidence, 0.7)
    assert.equal(typeof logged.latencyMs, 'number')
  } finally {
    stub.restore()
  }
})

test('survey throws, after one retry, when the reply is not a ClutterReading', async () => {
  const stub = stubbedProvider('The desk looks cluttered, about 0.7.')
  try {
    await assert.rejects(
      () => stub.provider.survey(makeSurvey([makeFrame(1)])),
      /deepseek survey failed: response was not schema-valid ClutterReading JSON/,
    )

    assert.equal(stub.bodies.length, 2)
    assert.equal(stub.warns.length, 1)
    assert.equal(stub.warns[0]?.msg, 'deepseek clutter parse failed, retrying once')
    assert.deepEqual(stub.infos, [])
  } finally {
    stub.restore()
  }
})

test('parseClutterContent accepts a fenced reading', () => {
  const parsed = parseClutterContent(`\`\`\`json\n${JSON.stringify(READING)}\n\`\`\``)

  assert.equal(parsed?.score, 0.72)
  assert.equal(parsed?.hotspots[0]?.label, 'papers')
  assert.equal(parsed?.because, 'papers across the left of the desk')
})

test('parseClutterContent rejects what the contract forbids, and prose', () => {
  const contents: Record<string, unknown> = {
    'score above 1': JSON.stringify({ ...READING, score: 1.4 }),
    'unknown label': JSON.stringify({
      ...READING,
      hotspots: [{ ...READING.hotspots[0], label: 'socks' }],
    }),
    'missing hotspots': JSON.stringify({ score: 0.5, evidence: [], confidence: 0.5, because: 'x' }),
    prose: 'The desk looks cluttered, about 0.7.',
    'not a string at all': null,
  }

  for (const [name, content] of Object.entries(contents)) {
    assert.equal(parseClutterContent(content), null, name)
  }
})
