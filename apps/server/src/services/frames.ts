import type { FrameRejectionCode, MediaAudioMeta, MediaFrameMeta } from '@heli/contracts'

import { getObject, putObject, storageBackend } from '../lib/storage.js'
import type { ObjectRef } from '../lib/storage.js'
import { endHubSession, publish, resetHub } from '../media/hub.js'

/**
 * Media intake: the single place a JPEG or a PCM chunk from the device becomes
 * something the rest of the server can use.
 *
 * Two rules shape this file:
 *   - Video is persisted (a still must be resolvable later), audio is not. Raw
 *     microphone samples never leave memory, so there is nothing to leak, to
 *     subpoena or to accidentally ship to a model provider.
 *   - Every in-memory structure is bounded, because a device pushing 8 fps into
 *     a session nobody closed must not grow the heap until the box dies.
 */

/** `docs/03-device-contract.md` §5: JPEG only, ≤ 2 MB and ≤ 1600 px long edge. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_FRAME_DIMENSION = 1600

/* ---- rejection ----------------------------------------------------------- */

/**
 * A rejected frame travels with a machine-readable `code` so the caller branches
 * on the code rather than on an English sentence, and with the `statusCode` that
 * fits it — which is this codebase's convention for every error that can reach a
 * request (`plugins/errors.ts` reads exactly this field), so a rejection that
 * escaped the route's own catch would answer 413 or 415 rather than a masked 500.
 *
 * The union itself is the contract's (`packages/contracts/src/desk.ts`), because
 * the rig branches on these three strings and reads them out of
 * `dist/json-schema.json`. This file used to hand-write the same three values,
 * which is exactly the duplication "contracts are law" forbids.
 */
export class FrameRejectedError extends Error {
  readonly code: FrameRejectionCode
  readonly statusCode: number

  constructor(code: FrameRejectionCode, statusCode: number, message: string) {
    super(message)
    this.name = 'FrameRejectedError'
    this.code = code
    this.statusCode = statusCode
  }
}

const notJpeg = (reason: string): FrameRejectedError =>
  new FrameRejectedError('frame_not_jpeg', 415, `Not a usable JPEG: ${reason}.`)

/* ---- the marker walk ----------------------------------------------------- */

/**
 * SOF markers carry the dimensions. 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) sit
 * in the same numeric range but are not frame headers.
 */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

/**
 * Walks the JPEG segment chain and returns the dimensions from the first SOF
 * marker.
 *
 * Walking each segment by its declared length is the whole point: an APP1 EXIF
 * block carries a complete thumbnail JPEG — a photo with its own FFD8, its own
 * SOF and its own dimensions — and a "scan forward for FFC0" guess happily
 * returns the thumbnail's size instead of the frame's. Same for APP0/APP1
 * payloads that merely contain those bytes.
 *
 * Throws a 415 `frame_not_jpeg` for anything that is not a walkable JPEG: a
 * truncated stream, a lost marker, or a stream with no SOF at all.
 *
 * Known limit, deliberately not closed here: this validates the **header**, not
 * the whole stream. A JPEG cut short after its SOF still walks cleanly, so a
 * truncated upload is accepted and reaches a provider that cannot decode it,
 * where the loss surfaces as a provider error rather than a 422. Closing it means
 * checking for the `FFD9` end-of-image marker — scanning the last few bytes,
 * since some encoders append padding after it — which is a change to HELI-014's
 * validation contract and wants its own row rather than a drive-by.
 */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4) throw notJpeg('shorter than a JPEG header')
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw notJpeg('missing the FFD8 start-of-image marker')
  }

  let offset = 2

  while (offset < bytes.length) {
    // Between segments we must be sitting on a marker introducer.
    if (bytes[offset] !== 0xff) {
      throw notJpeg(`expected a marker at byte ${offset}, found ${bytes[offset] ?? 0}`)
    }

    // A marker may be padded with any number of 0xFF fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) break // trailing fill, no marker behind it

    const marker = bytes[offset] ?? 0
    offset += 1

    // Standalone markers: no length field and no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) continue

    // Start of scan, or end of image: the SOF had to come before either.
    if (marker === 0xda || marker === 0xd9) break

    // 0x00 is only legal as a stuffed byte inside entropy-coded scan data, and
    // we never walk into that.
    if (marker === 0x00) throw notJpeg('stuffed 0x00 byte outside the scan')

    if (offset + 2 > bytes.length) throw notJpeg('truncated segment length')
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)

    // `length` counts its own two bytes, so it can never be smaller than 2, and
    // the segment has to fit inside the stream we were handed.
    if (length < 2 || offset + length > bytes.length) {
      throw notJpeg('truncated segment payload')
    }

    if (isStartOfFrame(marker)) {
      // Payload: precision(1) height(2) width(2) components(1) … and the spec's
      // minimum Lf is 8, but 7 is all we need to read width and height.
      if (length < 7) throw notJpeg('start-of-frame segment without dimensions')

      const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)
      const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
      if (width === 0 || height === 0) throw notJpeg('start-of-frame with zero dimensions')

      return { width, height }
    }

    // Skip the payload whole. This is what makes the EXIF thumbnail harmless.
    offset += length
  }

  throw notJpeg('no start-of-frame marker before the end of the stream')
}

/* ---- rings --------------------------------------------------------------- */

/**
 * Bounded metadata rings. 240 frames is 30 s at the contract's default 8 fps,
 * 600 audio chunks is a minute of 100 ms chunks — enough for a "what did we just
 * see" query, and a hard ceiling on a socket that forgets to unsubscribe.
 */
const FRAME_RING_LIMIT = 240
const AUDIO_RING_LIMIT = 600

/**
 * The contract shapes (`packages/contracts/src/media.ts`) plus the two things
 * the server needs and the device never sees: which session it belongs to, and
 * where the bytes actually live. Extending rather than re-declaring keeps the
 * socket control message a subset of this type.
 */
export interface VideoFrameMeta extends MediaFrameMeta {
  sessionId: string
  ref: ObjectRef
}

export interface AudioChunkMeta extends MediaAudioMeta {
  sessionId: string
  sampleRate: number
  channels: number
}

export interface VideoFrameInput {
  sessionId: string
  bytes: Uint8Array
  seq: number
  ts?: string
  /**
   * How much of this session's video to hold.
   *
   * `recent` (the default) keeps a bounded ring — what the live fan-out and the
   * mock device want. `newest` keeps exactly one, which is the desk path: the rig
   * uploads at about 2 fps, and a stale still is worse than a missing one, so it
   * drops what it held rather than letting a backlog build behind the frame the
   * next assessment is about to read.
   */
  retain?: 'recent' | 'newest'
}

export interface AudioChunkInput {
  sessionId: string
  bytes: Uint8Array
  ts?: string
  sampleRate: number
  channels: number
}

interface MediaSessionState {
  frames: VideoFrameMeta[]
  audio: AudioChunkMeta[]
  /**
   * Frames accepted for this session since this process started, whether or not
   * they are still held. This is what `DeskStatus.frames` means — the desk panel
   * shows it climbing — and it is deliberately not `frames.length`, which is a
   * retention ring and sits at 1 once a desk keeps only its newest frame.
   */
  accepted: number
}

const sessions = new Map<string, MediaSessionState>()

/**
 * The mirrored latest still, deliberately NOT part of `MediaSessionState`.
 *
 * §6.4: "On our side the last frame is kept so a still can still be served."
 * `endMediaSession` runs when the device's **socket** closes, and the session it
 * was serving is usually still open — so a still that vanished at that moment
 * would 404 exactly when someone is looking at the screen wondering why the
 * video stopped. One `ObjectRef` per session costs nothing to keep, and the
 * bytes it points at are in the object store, which outlives all of this.
 */
const latestFrames = new Map<string, ObjectRef>()

const sessionState = (sessionId: string): MediaSessionState => {
  let state = sessions.get(sessionId)
  if (state === undefined) {
    state = { frames: [], audio: [], accepted: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

const pushBounded = <T>(ring: T[], value: T, limit: number): void => {
  ring.push(value)
  if (ring.length > limit) ring.splice(0, ring.length - limit)
}

/**
 * Object keys become URL path segments as soon as the app serves a still, and a
 * key with `:` and `.` in it is a nuisance there: dots read as a file extension
 * to every proxy and static handler in the way, and some normalise dotted
 * segments away entirely. The timestamp is only a sortable prefix, so flattening
 * the ISO-8601 punctuation costs nothing and keeps the key boring.
 *
 * The session id is slugged for the same class of reason: it is an opaque
 * identifier from the database, and a `/` or a `..` in it must never be able to
 * reach outside its own prefix.
 */
const frameKey = (sessionId: string, ts: string, seq: number): string =>
  `sessions/${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}/frames/${ts.replace(/[:.]/g, '-')}-${seq}.jpg`

/* ---- intake -------------------------------------------------------------- */

/**
 * The desk's one frame lives at one key, so every upload overwrites the last.
 *
 * This is what makes "only one frame is retained per session" true of the
 * **bytes** and not merely of the metadata ring. A per-frame key plus a delete
 * would need a delete in `lib/storage.ts`, which belongs to HELI-014 and not to
 * this row — and overwriting is better anyway, because it cannot fail halfway
 * and leave the previous frame sitting in the bucket.
 *
 * A stable key is also a stable URL, which is what the desktop's preview wants:
 * `GET /v1/sessions/:id/frame.jpg` is pointed at one path and caches for 5 s.
 */
const latestFrameKey = (sessionId: string): string =>
  `sessions/${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}/frames/latest.jpg`

/**
 * The timestamp is caller-supplied — a header on the desk path, a message field
 * on the device path — and it used to reach the object key verbatim. Slugging
 * neutralised `..`, but `/` survived, so a caller could shape the key's
 * directories; and a long enough value pushed the key past S3's 1024-byte limit
 * for a 500 that the memory backend would never have produced. Parsing it here
 * means only a real ISO instant can reach a key or a contract field, and an
 * unparseable one is replaced rather than propagated.
 */
const normaliseTs = (value: string | undefined): string => {
  if (value === undefined) return new Date().toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

/**
 * Validates, stores and fans out one video frame.
 *
 * Order matters: size first (cheapest, and the cap the device contract names
 * `frame_too_large` whatever the bytes are), then the marker walk, then the
 * pixel cap. Nothing is written to the object store until all three pass — a
 * rejected frame must not leave an object behind.
 */
export async function ingestVideoFrame(input: VideoFrameInput): Promise<VideoFrameMeta> {
  const { sessionId, bytes, seq } = input
  const ts = normaliseTs(input.ts)

  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new FrameRejectedError(
      'frame_too_large',
      413,
      `Frame is ${bytes.byteLength} bytes; the cap is ${MAX_FRAME_BYTES}.`,
    )
  }

  const { width, height } = readJpegSize(bytes)

  if (Math.max(width, height) > MAX_FRAME_DIMENSION) {
    throw new FrameRejectedError(
      'frame_too_wide',
      413,
      `Frame is ${width}x${height}; the long edge cap is ${MAX_FRAME_DIMENSION}.`,
    )
  }

  const ref = await putObject({
    // One key per session on the desk path, so the previous frame is overwritten
    // rather than accumulating at the rig's ~2 fps.
    key: input.retain === 'newest' ? latestFrameKey(sessionId) : frameKey(sessionId, ts, seq),
    body: bytes,
    contentType: 'image/jpeg',
  })

  const meta: VideoFrameMeta = {
    sessionId,
    seq,
    ts,
    bytes: bytes.byteLength,
    width,
    height,
    ref,
  }

  const state = sessionState(sessionId)
  state.accepted += 1
  if (input.retain === 'newest') {
    // The desk path. Drop what we held instead of queueing behind it: the one
    // frame that matters is the newest, and this is what makes
    // "only one frame is retained per session" true without a second code path
    // for storing it.
    state.frames.length = 0
    state.frames.push(meta)
  } else {
    pushBounded(state.frames, meta, FRAME_RING_LIMIT)
  }
  latestFrames.set(sessionId, ref)

  publish(sessionId, { kind: 'frame', frame: meta })

  return meta
}

/**
 * Root-mean-square of a PCM S16LE chunk, normalised to 0..1 — 0 is digital
 * silence, ~1 is a full-scale square wave. It is what drives the app's audio
 * meter, so it has to come from the samples rather than from a constant.
 */
const readRms = (bytes: Uint8Array): number => {
  // A trailing odd byte cannot be half a sample, so it is ignored.
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples === 0) return 0

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sum = 0

  for (let i = 0; i < samples; i += 1) {
    // Little-endian and explicit: `noUncheckedIndexedAccess` makes the `bytes[0]
    // | bytes[1] << 8` hand-roll a type error, and DataView is the honest way to
    // read interleaved PCM anyway.
    const sample = view.getInt16(i * 2, true) / 32768
    sum += sample * sample
  }

  return Math.sqrt(sum / samples)
}

/**
 * Duration and level of one audio chunk. `async` purely so both tagged-binary
 * paths look identical to the caller (HELI-012 awaits one or the other).
 *
 * There is deliberately no `putObject` call anywhere in here: audio is metadata
 * only, the samples are dropped as soon as this returns.
 */
export async function ingestAudioChunk(input: AudioChunkInput): Promise<AudioChunkMeta> {
  const { sessionId, bytes } = input
  const ts = input.ts ?? new Date().toISOString()

  // Guard the divisor: a zero or fractional rate from a bad `media.start` must
  // not produce NaN durations downstream.
  const sampleRate = Math.max(1, Math.floor(input.sampleRate))
  const channels = Math.max(1, Math.floor(input.channels))

  const durationMs = Math.round((bytes.byteLength / (sampleRate * channels * 2)) * 1000)

  const meta: AudioChunkMeta = {
    sessionId,
    ts,
    bytes: bytes.byteLength,
    durationMs,
    rms: readRms(bytes),
    sampleRate,
    channels,
  }

  // Metadata-only ring: bounded, in memory, and never written to storage.
  pushBounded(sessionState(sessionId).audio, meta, AUDIO_RING_LIMIT)

  publish(sessionId, { kind: 'audio', audio: meta })

  return meta
}

/* ---- reads --------------------------------------------------------------- */

/**
 * The still that is always resolvable for a session, or null if none arrived.
 * Survives `endMediaSession` on purpose — see `latestFrames`.
 */
export const latestFrameRef = (sessionId: string): ObjectRef | null =>
  latestFrames.get(sessionId) ?? null

/**
 * The newest frame for a session, **resolved from the store** when this process
 * has not seen one.
 *
 * `latestFrameRef` is an in-memory mirror, which means a server that restarted
 * mid-session has no ref even though the rig's frame is sitting in the bucket —
 * and the loop would then assess nothing until the rig uploaded again. That is
 * not "the frame store is the truth", it is the mirror being the truth.
 *
 * The desk path writes to one stable key per session, so the ref is *derivable*:
 * when the mirror is empty we ask the store whether that key is there, and warm
 * the mirror with what we find. On the non-desk path the key carries a timestamp
 * and a seq, so this probe simply misses and answers null — the same answer the
 * mirror would have given, at the cost of one round trip per session.
 */
export async function resolveLatestFrameRef(sessionId: string): Promise<ObjectRef | null> {
  const mirrored = latestFrames.get(sessionId)
  if (mirrored !== undefined) return mirrored

  const stored = await getObject(latestFrameKey(sessionId))
  if (stored === null) return null

  const ref: ObjectRef = {
    key: latestFrameKey(sessionId),
    contentType: stored.contentType,
    bytes: stored.body.byteLength,
    backend: storageBackend(),
  }
  latestFrames.set(sessionId, ref)
  return ref
}

/** Frame bytes back out of the object store; null when the key is gone. */
export async function getFrame(ref: ObjectRef | string): Promise<Uint8Array | null> {
  const object = await getObject(ref)
  return object ? object.body : null
}

/**
 * Frames accepted for this session since this process started. Monotonic, so it
 * keeps climbing as the rig uploads even though only the newest is retained, and
 * it survives a frame being dropped on retention. Process-local, like everything
 * else here: a restart starts it again from zero.
 *
 * (`listFrames(sessionId).length` is the count of what is *held*, which on the
 * desk path is always one. Two different questions, so two names.)
 */
export const framesAccepted = (sessionId: string): number =>
  sessions.get(sessionId)?.accepted ?? 0

/** A copy: the ring is the server's, and a caller must not be able to mutate it. */
export const listFrames = (sessionId: string): VideoFrameMeta[] => [
  ...(sessions.get(sessionId)?.frames ?? []),
]

export const countAudioChunks = (sessionId: string): number =>
  sessions.get(sessionId)?.audio.length ?? 0

export const listAudioMeta = (sessionId: string): AudioChunkMeta[] => [
  ...(sessions.get(sessionId)?.audio ?? []),
]

/**
 * Releases everything held for one session — called when the device socket
 * closes. It also ends the hub session, so a live subscriber learns the stream
 * stopped instead of waiting on a screen that will never update again. The
 * object store is untouched: stored frames outlive the session on purpose.
 */
export function endMediaSession(sessionId: string): void {
  sessions.delete(sessionId)
  endHubSession(sessionId, 'media.end')
}

/** Drops all in-memory media state, the still mirror included. Probes and tests. */
export function resetMedia(): void {
  sessions.clear()
  latestFrames.clear()
  resetHub()
}
