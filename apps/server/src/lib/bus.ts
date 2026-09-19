import type { LiveEvent, Observation } from '@heli/contracts'

import { childLogger } from '../logger.js'

const log = childLogger({ module: 'bus' })

/**
 * The in-process fan-out behind `GET /v1/live/:sessionId`.
 *
 * Process-local and deliberately dumb: a `Map` of sessions, each holding the
 * last few observations and the set of listeners currently attached to that
 * session. Nothing here touches the database or fastify, so the loop that
 * *produces* an observation (HELI-021) and the route that *streams* it can both
 * depend on this file without depending on each other — and a unit test can
 * drive the bus without a socket.
 *
 * It is not a queue and not durable. An event published while nobody is
 * listening is gone, except for the observation ring below. That is the right
 * trade for a live channel: a subscriber that missed something asks the REST
 * routes for the truth; this channel exists to make what is happening *now*
 * visible, which is also why the phase doc gives it a bounded replay and not a
 * log.
 */

/**
 * How many observations a session keeps for replay, and how many are pulled
 * back out of the database when the ring is empty. The phase doc names 20.
 */
export const REPLAY_LIMIT = 20

type Listener = (event: LiveEvent) => void

interface Channel {
  /**
   * The last `REPLAY_LIMIT` observations for this session, oldest first. Only
   * observations are retained: they are the rows a late-joining window is
   * mostly made of, they are what the phase doc asks to replay, and a ring of
   * every event kind would be a second copy of the event log with none of the
   * guarantees. Interventions, windows and state arrive live or not at all —
   * the client re-reads them over REST on connect, and each one is superseded
   * by the next, so a stale replay of those would be worse than none.
   */
  ring: Observation[]
  listeners: Set<Listener>
}

const channels = new Map<string, Channel>()

function channelFor(sessionId: string): Channel {
  let channel = channels.get(sessionId)
  if (!channel) {
    channel = { ring: [], listeners: new Set() }
    channels.set(sessionId, channel)
  }
  return channel
}

/**
 * A listener is typed as returning `void`, but a caller can still hand in an
 * `async` function or any other thenable, and a rejection from one of those
 * would otherwise surface as an unhandled rejection and take the process with
 * it. Detect it rather than trusting the signature.
 */
function thenOf(value: unknown): PromiseLike<unknown> | null {
  if (value === null) return null
  if (typeof value !== 'object' && typeof value !== 'function') return null
  const then = (value as { then?: unknown }).then
  return typeof then === 'function' ? (value as PromiseLike<unknown>) : null
}

/**
 * One listener, one event, and no way for the listener to reach the sender: a
 * throwing subscriber, one that returns a rejected promise, or one that has
 * already unsubscribed mid-delivery must not stop the other subscribers from
 * being told, and must not propagate into the code that published.
 */
function deliver(listener: Listener, event: LiveEvent, sessionId: string): void {
  try {
    const result: unknown = listener(event)
    const pending = thenOf(result)
    if (pending) {
      void Promise.resolve(pending).catch((error: unknown) => {
        log.warn(
          { sessionId, event: event.event, err: error },
          'a live subscriber rejected an event',
        )
      })
    }
  } catch (error) {
    log.warn({ sessionId, event: event.event, err: error }, 'a live subscriber threw on an event')
  }
}

/**
 * Publishes an event to everyone watching a session.
 *
 * An observation also lands in the ring, and it lands there *before* the
 * listeners are called: a listener is allowed to subscribe someone else from
 * inside its own call, and in that order the newcomer sees the observation in
 * its replay rather than losing it to a half-registered listener.
 *
 * A non-observation event does not create a channel. Nothing is retained for
 * it, so a session nobody is watching would only leak an empty `Map` entry that
 * only `endBusSession` would ever free.
 */
export function publish(sessionId: string, event: LiveEvent): void {
  const channel = channels.get(sessionId)

  if (event.event === 'observation') {
    const target = channel ?? channelFor(sessionId)
    target.ring.push(event.data)
    if (target.ring.length > REPLAY_LIMIT) {
      target.ring.splice(0, target.ring.length - REPLAY_LIMIT)
    }
  }

  if (!channel) return

  // Snapshot the set: a listener that unsubscribes during this loop must not
  // reshuffle the iteration, and the ones already notified must stay notified.
  for (const listener of [...channel.listeners]) {
    if (!channel.listeners.has(listener)) continue
    deliver(listener, event, sessionId)
  }
}

export interface Subscription {
  /** What the channel already holds for this session, oldest first. */
  replay: LiveEvent[]
  /** Detaches the listener. Safe to call more than once. */
  unsubscribe: () => void
}

/**
 * The whole reason this function exists, rather than an exported "read the
 * ring" plus an exported "add a listener": the snapshot and the registration
 * happen in the same synchronous step, with no `await` between them. A client
 * can therefore never fall into the gap — an event is either already in the
 * snapshot it is handed, or published after it is registered and delivered
 * live. Splitting the two would leave a window in which an observation is
 * published, missed by the replay, and missed by the listener, which is the
 * one kind of bug this channel cannot show you.
 */
export function subscribeWithReplay(sessionId: string, listener: Listener): Subscription {
  const channel = channelFor(sessionId)

  const replay: LiveEvent[] = channel.ring.map((data) => ({ event: 'observation', data }))
  channel.listeners.add(listener)

  let active = true
  return {
    replay,
    unsubscribe: () => {
      if (!active) return
      active = false
      channel.listeners.delete(listener)
    },
  }
}

/** How many listeners are attached to a session right now. */
export function subscriberCount(sessionId: string): number {
  return channels.get(sessionId)?.listeners.size ?? 0
}

/**
 * The name this event is written under on the wire: `event: observation` and so
 * on. The contract's discriminant *is* the SSE event name — the desktop client
 * parses with `LiveEvent` and binds `addEventListener(name, ...)` for the four
 * literals — so this is a rename of a field, kept as a function so the SSE
 * writer never grows its own copy of the mapping.
 */
export function liveEventName(event: LiveEvent): LiveEvent['event'] {
  return event.event
}

/**
 * A session is over. The ring is the only thing here that outlives the requests
 * that filled it, so this is where it is released.
 *
 * Listeners are deliberately left alone: a listener belongs to an open browser
 * tab, not to the session row, and the route unsubscribes its own listener when
 * that tab goes away. Dropping them here would leave a stream that is open and
 * permanently silent, which looks exactly like a healthy connection and is
 * worse than one that closes.
 */
export function endBusSession(sessionId: string): void {
  const channel = channels.get(sessionId)
  if (!channel) return

  channel.ring.length = 0
  // The map entry is only worth keeping while something is still listening.
  if (channel.listeners.size === 0) channels.delete(sessionId)
}

/**
 * Forgets every session. For tests and for a dev server that is about to reuse
 * a session id — the ring is process-local state, and a fresh process is the
 * only other way to get a clean one.
 */
export function resetBus(): void {
  channels.clear()
}
