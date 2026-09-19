import { childLogger } from '../logger.js'
// Type-only, and it has to stay that way: `frames.ts` imports `publish` from
// here at runtime, so a value import in this direction would close the cycle.
import type { AudioChunkMeta, VideoFrameMeta } from '../services/frames.js'

const log = childLogger({ module: 'media.hub' })

/**
 * A tiny in-process fan-out for live media, keyed by session.
 *
 * Everything here exists to make one promise: **the device's socket never waits
 * on a consumer**. The dashboard that renders frames, the SSE stream, the
 * assessment loop that wants a still — any of them can be slow, busy or broken,
 * and `publish` still returns in microseconds because it only appends to a
 * bounded per-subscriber queue and hands the delivery to a `setImmediate`.
 *
 * The bounded queue is the other half of that promise. A subscriber that cannot
 * keep up accumulates at most `QUEUE_DEPTH` messages; past that we drop the
 * *oldest video frame* first, because a stale still is the least valuable thing
 * in flight — a missing one is fine, a two-second-old one is a lie about what
 * the desk looks like right now. Audio and the terminal `end` are kept in
 * preference to it.
 */

export type HubMessage =
  | { kind: 'frame'; frame: VideoFrameMeta }
  | { kind: 'audio'; audio: AudioChunkMeta }
  | { kind: 'end'; reason: string }

export type HubListener = (message: HubMessage) => void

/** Small on purpose. One frame of slack per consumer, not a video buffer. */
const QUEUE_DEPTH = 8

interface Subscriber {
  listener: HubListener
  queue: HubMessage[]
  /** A drain is already scheduled (or running) for this subscriber. */
  draining: boolean
}

interface HubSession {
  subscribers: Set<Subscriber>
  droppedFrames: number
  /** The terminal `end` has been published; a second call must not repeat it. */
  ended: boolean
}

const sessions = new Map<string, HubSession>()

/**
 * A session record only exists while someone is listening to it. Nothing is
 * allocated for a session that has no subscriber — `publish` is a lookup and an
 * early return in that case, which is what keeps intake cheap.
 */
const sessionFor = (sessionId: string): HubSession => {
  let session = sessions.get(sessionId)
  if (session === undefined) {
    session = { subscribers: new Set<Subscriber>(), droppedFrames: 0, ended: false }
    sessions.set(sessionId, session)
  }
  return session
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'

/**
 * Delivers one subscriber's queue, one message at a time, with every call
 * guarded. A listener that throws or returns a rejected promise is logged and
 * skipped: one broken consumer must not starve the others, and it must certainly
 * not reach the device's socket.
 */
const drain = (sessionId: string, subscriber: Subscriber): void => {
  subscriber.draining = false

  while (subscriber.queue.length > 0) {
    const message = subscriber.queue.shift()
    if (message === undefined) break

    try {
      // The listener type is `=> void`, but a subscriber may be an async
      // function. Its promise is never awaited — attaching a rejection handler
      // is what stops it becoming an unhandled rejection that kills the process.
      const outcome: unknown = subscriber.listener(message)

      if (isPromiseLike(outcome)) {
        void Promise.resolve(outcome).catch((error: unknown) => {
          log.warn({ err: error, sessionId, kind: message.kind }, 'media subscriber rejected a message')
        })
      }
    } catch (error: unknown) {
      log.warn({ err: error, sessionId, kind: message.kind }, 'media subscriber threw on a message')
    }
  }
}

const scheduleDrain = (sessionId: string, subscriber: Subscriber): void => {
  if (subscriber.draining) return
  subscriber.draining = true
  // Never call the listener from inside `publish`: the device's frame handler
  // runs on the same event loop the listeners do.
  setImmediate(() => {
    drain(sessionId, subscriber)
  })
}

const enqueue = (
  sessionId: string,
  session: HubSession,
  subscriber: Subscriber,
  message: HubMessage,
): void => {
  if (subscriber.queue.length >= QUEUE_DEPTH) {
    // Full. Drop the oldest queued video frame and count it; if this subscriber
    // is behind on audio only, drop the oldest message instead.
    const staleFrameAt = subscriber.queue.findIndex((queued) => queued.kind === 'frame')
    if (staleFrameAt >= 0) {
      subscriber.queue.splice(staleFrameAt, 1)
      session.droppedFrames += 1
    } else {
      subscriber.queue.shift()
    }
  }

  subscriber.queue.push(message)
  scheduleDrain(sessionId, subscriber)
}

/**
 * Synchronous and non-blocking. It enqueues and returns; delivery happens on a
 * later tick. Never inline, never awaited.
 */
export const publish = (sessionId: string, message: HubMessage): void => {
  const session = sessions.get(sessionId)
  if (session === undefined) return // nobody has ever subscribed to this session

  for (const subscriber of session.subscribers) {
    enqueue(sessionId, session, subscriber, message)
  }
}

/**
 * Adds a subscriber and returns its unsubscribe function. Unsubscribing drops
 * whatever is still queued for it, so a closed socket cannot be delivered to.
 */
export const subscribe = (sessionId: string, listener: HubListener): (() => void) => {
  const session = sessionFor(sessionId)
  const subscriber: Subscriber = { listener, queue: [], draining: false }
  session.subscribers.add(subscriber)

  return () => {
    session.subscribers.delete(subscriber)
    subscriber.queue.length = 0

    // An ended session with nobody left is garbage. One that is still live keeps
    // its drop counter, which is the diagnostic worth having mid-session.
    if (session.ended && session.subscribers.size === 0) sessions.delete(sessionId)
  }
}

export const subscriberCount = (sessionId: string): number =>
  sessions.get(sessionId)?.subscribers.size ?? 0

/** Frames this session's subscribers were too slow to receive, since it opened. */
export const droppedFrames = (sessionId: string): number =>
  sessions.get(sessionId)?.droppedFrames ?? 0

/**
 * Publishes the terminal message for a session, once. Idempotent: a retry, or a
 * device that closes twice, does not produce a second `end`.
 *
 * Later messages are still fanned out rather than swallowed — a device may stop
 * and restart media inside one session (§6.4), and a hub that had permanently
 * muted a session after the first stop would silently lose the restart.
 */
export function endHubSession(sessionId: string, reason = 'closed'): void {
  const session = sessions.get(sessionId)
  if (session === undefined) return
  if (session.ended) return

  session.ended = true
  publish(sessionId, { kind: 'end', reason })

  // Nothing to deliver it to: do not keep a record for a session nobody watches.
  if (session.subscribers.size === 0) sessions.delete(sessionId)
}

/** Drops every subscriber and queue. For probes and tests only. */
export function resetHub(): void {
  for (const session of sessions.values()) {
    for (const subscriber of session.subscribers) subscriber.queue.length = 0
  }
  sessions.clear()
}
