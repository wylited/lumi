import { ApiAudioOut, ApiNudge } from '@heli/contracts'

/**
 * The loop's outbound half.
 *
 * The orchestrator decides; this gets the decision to a person. Everything
 * travels down the desktop socket, because the desktop is where the person is:
 * a spoken line arrives as `audio.out` followed by tagged PCM, and a tier-2
 * nudge arrives as an `ApiNudge` the desktop turns into a notification with an
 * action.
 *
 * The only thing the server side must expose is a lookup — `sessionId` in, the
 * live desktop socket out, or null. That is deliberately one function: this file
 * then owns the ordering, the payload shapes and the honest refusal when nobody
 * is connected.
 */

/** Where a line goes. One desk socket per session; nothing fancier. */
export interface LoopSenders {
  /** JSON to a session, for example the `audio.out` header. */
  sendToSession(sessionId: string, payload: unknown): boolean
  /** Tagged binary to a session. Absent means audio cannot reach the desk yet. */
  sendBinaryToSession?(sessionId: string, bytes: Buffer): boolean
  /** A tier-2 notification, with an action, where the person actually is. */
  sendNotification(sessionId: string, message: string): boolean
}

export interface DeskSocket {
  /** JSON to the Mac. Returns whether it was handed to the socket. */
  send(payload: unknown): boolean
  /** Tagged binary. Absent means this transport cannot carry audio. */
  sendBinary?(bytes: Buffer): boolean
}

export type DeskSocketLookup = (sessionId: string) => DeskSocket | null

export interface SenderDeps {
  /** The desk the person is sitting at: the desktop app or the rig. */
  desk: DeskSocketLookup
  /**
   * The phone, when one is paired and connected. It is the surface that leaves
   * the room with the person, so a nudge prefers it and speech follows it when
   * motion says the desk was left — see `away`.
   */
  phone?: DeskSocketLookup
  /**
   * True when the person is away from the desk. The phone's motion decides; an
   * unknown phone is never away, because a stale signal must not move a spoken
   * line to a pocket in another room.
   */
  away?: (sessionId: string) => boolean
  logger?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
  }
}

/**
 * Every sender answers honestly. A missing socket, a closed one, or a transport
 * that cannot carry audio returns `false`, and the caller records the line as
 * undelivered rather than pretending it spoke.
 *
 * Where a line goes is a routing question, not a policy one: the policy decided
 * the tier, and this decides which surface carries it.
 *   - speech follows the person: away → the phone, otherwise the desk first;
 *   - a nudge prefers the phone, because it is with them either way, and falls
 *     back to the desk.
 */
export function createDeskSenders(deps: SenderDeps): LoopSenders {
  const log = deps.logger
  const phone = deps.phone ?? (() => null)
  const away = deps.away ?? (() => false)

  function homeFor(sessionId: string, intent: 'speech' | 'nudge'): DeskSocket | null {
    const phoneSocket = safeLookup(phone, sessionId)
    const deskSocket = safeLookup(deps.desk, sessionId)

    if (intent === 'nudge') return phoneSocket ?? deskSocket
    if (away(sessionId)) return phoneSocket ?? deskSocket
    return deskSocket ?? phoneSocket
  }

  function safeLookup(lookup: DeskSocketLookup, sessionId: string): DeskSocket | null {
    try {
      return lookup(sessionId)
    } catch (error) {
      log?.warn({ sessionId, err: error }, 'outbound: a socket lookup threw')
      return null
    }
  }

  return {
    sendToSession(sessionId, payload) {
      const socket = homeFor(sessionId, 'speech')
      if (!socket) {
        log?.warn({ sessionId }, 'outbound: no surface connected, dropping payload')
        return false
      }
      // A malformed payload is a bug here, not a transient failure: say so in the
      // log rather than sending something the desktop will reject.
      const shape = payload as { t?: string } | null
      if (shape?.t === 'audio.out') {
        const parsed = ApiAudioOut.safeParse(payload)
        if (!parsed.success) {
          log?.warn({ sessionId, issues: parsed.error.issues }, 'outbound: malformed audio.out')
          return false
        }
      }
      try {
        return socket.send(payload)
      } catch (error) {
        log?.warn({ sessionId, err: error }, 'outbound: send threw')
        return false
      }
    },

    sendBinaryToSession(sessionId, bytes) {
      const socket = homeFor(sessionId, 'speech')
      if (!socket?.sendBinary) {
        log?.warn({ sessionId }, 'outbound: no binary channel on the chosen surface, audio dropped')
        return false
      }
      try {
        return socket.sendBinary(bytes)
      } catch (error) {
        log?.warn({ sessionId, err: error }, 'outbound: binary send threw')
        return false
      }
    },

    /** Tier 2. The phone shows it as a notification with one action; the desktop as a card. */
    sendNotification(sessionId, message) {
      const socket = homeFor(sessionId, 'nudge')
      if (!socket) {
        log?.warn({ sessionId }, 'outbound: no surface connected, nudge dropped')
        return false
      }
      const nudge = ApiNudge.safeParse({ t: 'nudge', observationId: null, message })
      if (!nudge.success) {
        log?.warn({ sessionId, issues: nudge.error.issues }, 'outbound: malformed nudge')
        return false
      }
      try {
        return socket.send(nudge.data)
      } catch (error) {
        log?.warn({ sessionId, err: error }, 'outbound: nudge threw')
        return false
      }
    },
  }
}

/**
 * Nothing is connected. Used by the dev server and by a test, so the loop can be
 * run with no Mac attached and still record what it would have said.
 */
export const noopSenders: LoopSenders = {
  sendToSession: () => false,
  sendBinaryToSession: () => false,
  sendNotification: () => false,
}
