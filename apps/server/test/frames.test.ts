import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * HELI-093 — the survey frame source.
 *
 * The store keeps one anchor and one archive ring **per source**, so a sweep
 * frame lands beside the live camera frame instead of on top of it. These cases
 * pin that separation: a `survey` frame is accepted and readable as its own
 * source, and reading the camera never sees it.
 *
 * The last case pins the other half of the row: the **assess** read iterates
 * `ASSESS_SOURCES`, not `FRAME_SOURCES`, so a frame the sweep just uploaded can
 * never become the picture the per-tick assessment judges.
 */

// The server modules read env at import time and the test machine may have no
// .env at all (a clean clone). Set the two required values before importing.
process.env.DATABASE_URL ??= 'postgresql://heli:heli@localhost:5432/heli?schema=public'
process.env.JWT_SECRET ??= 'test-secret'
process.env.LOG_LEVEL ??= 'silent'

// A static import is hoisted above the env lines above, so it would read the
// environment before the test has set it. The same reason and pattern as
// `live-desktop.test.ts`.
const { ingestVideoFrame, isFrameSource, latestFrameRef, listFrames, getFrame, resetMedia } =
  await import('../src/services/frames.js')

// The loop's Prisma binding, imported the same way and for the same reason: a static
// import is hoisted above the env lines above and would read the environment before the
// test has set it. `frames()` touches no table (it reads the frame store), so the reader
// is safe to build here with no database: the case below is about which sources it reads,
// not about Postgres.
const { createPrismaReader } = await import('../src/observe/persistence.js')

/**
 * A minimal walkable JPEG: SOI, one SOF0 carrying the dimensions, EOI. It is not
 * decodable pixels, but `readJpegSize` only walks the header — which is exactly
 * what intake validates — so this is the shape the store accepts.
 */
const jpeg = (width: number, height: number): Uint8Array =>
  Uint8Array.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, 0x08, // SOF0, length 11, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, // one component
    0xff, 0xd9, // EOI
  ])

const sessionId = 'session_frames_test'

test('a survey frame is accepted as its own source and never read as the camera', async () => {
  resetMedia()

  const camera = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(640, 480),
    seq: 1,
    source: 'camera',
  })
  const survey = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(1280, 720),
    seq: 9,
    source: 'survey',
  })

  assert.equal(survey.source, 'survey')
  assert.equal(survey.seq, 9)
  assert.equal(survey.width, 1280)
  assert.equal(survey.height, 720)

  // The survey frame is readable through its own source, with its own anchor.
  const surveyRing = listFrames(sessionId, 'survey')
  assert.equal(surveyRing.length, 1)
  assert.equal(surveyRing[0]?.seq, 9)
  assert.equal(surveyRing[0]?.source, 'survey')
  assert.equal(latestFrameRef(sessionId, 'survey')?.key, `sessions/${sessionId}/survey/latest.jpg`)

  const bytes = await getFrame(survey.ref)
  assert.ok(bytes !== null, 'the survey anchor should resolve out of the store')
  assert.equal(bytes.byteLength, survey.bytes)

  // The camera read holds only the camera frame, and the camera anchor is
  // untouched by the sweep.
  const cameraRing = listFrames(sessionId, 'camera')
  assert.equal(cameraRing.length, 1)
  assert.equal(cameraRing[0]?.seq, 1)
  assert.equal(latestFrameRef(sessionId, 'camera')?.key, camera.ref.key)
})

test('a second survey frame replaces the survey anchor, not the camera anchor', async () => {
  resetMedia()

  const camera = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(640, 480),
    seq: 1,
    source: 'camera',
  })
  const first = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(640, 480),
    seq: 1,
    source: 'survey',
  })
  const second = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(640, 480),
    seq: 2,
    source: 'survey',
  })

  // Both sweeps are held in the ring; the anchor is one stable key, overwritten
  // in place, so the newest survey bytes are what it resolves to.
  const ring = listFrames(sessionId, 'survey')
  assert.equal(ring.length, 2)
  assert.deepEqual(
    ring.map((frame) => frame.seq),
    [1, 2],
  )

  const anchorKey = `sessions/${sessionId}/survey/latest.jpg`
  assert.equal(first.ref.key, anchorKey)
  assert.equal(second.ref.key, anchorKey)
  assert.equal(latestFrameRef(sessionId, 'survey')?.key, anchorKey)
  assert.ok((await getFrame(anchorKey)) !== null, 'the overwritten anchor still resolves')

  assert.equal(latestFrameRef(sessionId, 'camera')?.key, camera.ref.key)
  assert.equal(listFrames(sessionId, 'camera').length, 1)
})

test('survey is an accepted source and an unknown one is still refused', () => {
  assert.equal(isFrameSource('survey'), true)
  assert.equal(isFrameSource('camera'), true)
  assert.equal(isFrameSource('screen'), true)
  assert.equal(isFrameSource('webcam'), false)
  assert.equal(isFrameSource(''), false)
  assert.equal(isFrameSource(undefined), false)
})

/**
 * The behaviour `createPrismaReader.frames()` exists to guarantee: it iterates
 * `ASSESS_SOURCES` (`camera`, `screen`), so the per-tick assessment is handed the
 * two lenses of the moment and never the deliberate reading the sweep just took.
 * Reverting that line to `FRAME_SOURCES` would put a survey frame in the model's
 * prompt as "the desk" instead of the live view — which is exactly what this
 * asserts against.
 */
test('the assess read takes the camera frame and never the survey one', async () => {
  resetMedia()

  const camera = await ingestVideoFrame({
    sessionId,
    bytes: jpeg(640, 480),
    seq: 1,
    source: 'camera',
  })
  await ingestVideoFrame({ sessionId, bytes: jpeg(1280, 720), seq: 9, source: 'survey' })

  const frames = await createPrismaReader().frames(sessionId)

  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.kind, 'desk')
  assert.equal(frames[0]?.ref, camera.ref.key)
  assert.ok(frames[0]?.bytes !== null, 'the camera bytes should come back out of the store')
  assert.ok(!frames.some((frame) => frame.ref.includes('/survey/')))
})
