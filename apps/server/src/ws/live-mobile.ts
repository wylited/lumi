/**
 * Where the loop's line lands when the person is not at the desk.
 *
 * The phone says `hello` (or its signals name a session) and this index answers
 * the loop's outbound lookup for that session. Same shape as
 * `live-desktop.ts`, and deliberately the same interface, so `observe/outbound.ts`
 * can hold either or both without knowing which is which.
 *
 * Module state by the same reasoning: one process, one server, a writer and a
 * reader that must agree on one map.
 */

/** A live phone, from the loop's point of view: JSON and tagged binary. */
export interface LiveMobileSocket {
  /** One JSON frame, already validated against `ApiToMobile`. */
  send(payload: unknown): boolean
  /** One tagged binary frame (`MEDIA_TAG.audio` + PCM). */
  sendBinary(bytes: Buffer): boolean
}

const bySession = new Map<string, LiveMobileSocket>()

export function attachMobileSocket(sessionId: string, socket: LiveMobileSocket): void {
  bySession.set(sessionId, socket)
}

export function detachMobileSocket(sessionId: string, socket: LiveMobileSocket): void {
  if (bySession.get(sessionId) === socket) bySession.delete(sessionId)
}

export function mobileSocketFor(sessionId: string): LiveMobileSocket | null {
  return bySession.get(sessionId) ?? null
}
