/**
 * Where the loop's line lands.
 *
 * A desktop connects to `/ws/desktop` and says, in its `hello`, which session it
 * is watching. That message is the only declaration of "the person is here", so
 * it is also the index: session id in, the live socket out. The loop's outbound
 * half asks for exactly this shape (`DeskSocketLookup` in `observe/outbound.ts`)
 * and an absent entry is the honest answer that nobody is attached.
 *
 * Module state on purpose: one process, one server, and the writer
 * (`ws/desktop.ts`) and the reader (`index.ts`) are two files that must agree on
 * one map. A test that builds two servers in one process and attaches both to
 * the same session is the only way to collide, and it would be wrong anyway.
 */

/** A live desktop, from the loop's point of view: JSON and tagged binary. */
export interface LiveDesktopSocket {
  /** One JSON frame, already validated against `ApiToDesktop`. */
  send(payload: unknown): boolean
  /** One tagged binary frame (`MEDIA_TAG.audio` + PCM). */
  sendBinary(bytes: Buffer): boolean
}

const bySession = new Map<string, LiveDesktopSocket>()

/**
 * The desktop named its session. The newest socket wins: a reconnect must not
 * leave the loop holding a socket that is about to close.
 */
export function attachDesktopSocket(sessionId: string, socket: LiveDesktopSocket): void {
  bySession.set(sessionId, socket)
}

/**
 * The socket is closing, or it has named a different session. The guard means a
 * socket that has already been superseded cannot evict its replacement when its
 * own close arrives late.
 */
export function detachDesktopSocket(sessionId: string, socket: LiveDesktopSocket): void {
  if (bySession.get(sessionId) === socket) bySession.delete(sessionId)
}

/** The loop's lookup. `null` means nobody is attached and the line is dropped. */
export function desktopSocketFor(sessionId: string): LiveDesktopSocket | null {
  return bySession.get(sessionId) ?? null
}
