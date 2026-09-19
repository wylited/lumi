import { ApiToDevice } from '@heli/contracts'
import type { ApiToDevice as ApiToDeviceMessage, DeviceCaps } from '@heli/contracts'

import { childLogger } from '../logger.js'

const log = childLogger({ module: 'ws.registry' })

/**
 * The live device sockets, in memory, keyed by device id.
 *
 * The device socket is a way **in**. Everything the server wants to say to a Pi
 * — a `command`, a `policy.update`, a synthesised line — is produced by code
 * that holds a device id and no socket, and this file is the only place that
 * pairing exists. `sendToDevice` is the point of it; the rest is bookkeeping
 * that keeps that call honest.
 *
 * Four properties it holds to:
 *
 *   - **One socket per device.** A Pi that reconnects — a Wi-Fi blip, a restart,
 *     a duplicate process — replaces its entry instead of adding one, and its
 *     previous socket is closed. A registry that accumulated entries would hand
 *     a command to a socket nobody is reading.
 *   - **A closed socket is never handed out.** `deviceSocket` answers `null`
 *     unless the socket is `OPEN`, and `sendToDevice` checks again, so a caller
 *     cannot send into a dead connection and believe it worked.
 *   - **A stale connection cannot write state that belongs to a newer one.**
 *     Every mutator takes the socket and refuses when it is no longer the
 *     registered one, which is what makes the replace-then-close ordering in
 *     `registerDevice` safe: the old socket's own teardown arrives later and is
 *     ignored.
 *   - **Process-local, and it resets on restart.** Nothing here is persisted,
 *     and that is correct rather than a gap to fill with a table: a socket that
 *     does not exist cannot be recovered from a row, and a device the app shows
 *     as online but which has no connection is worse than one it shows as
 *     absent.
 */

/** `WebSocket.OPEN`. `ws` is not a direct dependency of this package, so the constant is spelled out. */
const SOCKET_OPEN = 1

/**
 * The four socket members the registry needs, structurally.
 *
 * Deliberately not `import type { WebSocket } from 'ws'`: `ws` arrives
 * transitively through `@fastify/websocket`, so importing it here would depend
 * on a package this repo never declared. Both `ws`'s `WebSocket` and anything a
 * test hands in satisfy this, and this file has no business knowing about the
 * rest of the class.
 */
export interface DeviceSocketLike {
  readonly readyState: number
  send(data: string): void
  ping(): void
  close(code?: number, reason?: string): void
  terminate(): void
}

/** A device as the registry sees it. The socket itself is not part of the view. */
export interface RegisteredDevice {
  deviceId: string
  /** What the device reported in `hello`. `null` until it has. */
  caps: DeviceCaps | null
  agentVersion: string | null
  /** The session this socket opened, if it has one. */
  sessionId: string | null
  connectedAt: number
}

interface Registration extends RegisteredDevice {
  socket: DeviceSocketLike
}

const devices = new Map<string, Registration>()

/**
 * `sessionId → deviceId`, maintained alongside the registrations so a later row
 * can push a spoken line to whichever device owns a session without keeping its
 * own copy of the mapping and drifting from this one.
 */
const bySession = new Map<string, string>()

const view = (registration: Registration): RegisteredDevice => ({
  deviceId: registration.deviceId,
  caps: registration.caps,
  agentVersion: registration.agentVersion,
  sessionId: registration.sessionId,
  connectedAt: registration.connectedAt,
})

export interface RegisterDeviceInput {
  deviceId: string
  socket: DeviceSocketLike
  caps?: DeviceCaps | null
  agentVersion?: string | null
}

/**
 * Adds or replaces a device's socket, and closes whatever it replaced.
 *
 * The old socket is closed with a normal 1000 and the reason `replaced`, so a Pi
 * that reconnected without noticing its previous connection is still alive
 * learns that it is not the current one. Closing it *after* the new entry is
 * installed is deliberate: the old socket's `close` handler calls
 * `unregisterDevice` with the old socket, and the identity check there refuses
 * to remove the connection that just replaced it.
 */
export function registerDevice(input: RegisterDeviceInput): RegisteredDevice {
  const previous = devices.get(input.deviceId)

  const registration: Registration = {
    deviceId: input.deviceId,
    socket: input.socket,
    caps: input.caps ?? null,
    agentVersion: input.agentVersion ?? null,
    sessionId: null,
    connectedAt: Date.now(),
  }
  devices.set(input.deviceId, registration)

  if (previous !== undefined && previous.socket !== input.socket) {
    // The session the old socket owned is released by *its* teardown, which is
    // where `endMediaSession` and `endSignalSession` live; only the registry's
    // own pointer is dropped here, because no live socket owns it any more.
    if (previous.sessionId !== null && bySession.get(previous.sessionId) === input.deviceId) {
      bySession.delete(previous.sessionId)
    }

    try {
      previous.socket.close(1000, 'replaced')
    } catch (error: unknown) {
      log.warn({ err: error, deviceId: input.deviceId }, 'could not close the replaced device socket')
    }
    log.info(
      { deviceId: input.deviceId, previousSessionId: previous.sessionId },
      'a reconnecting device replaced its previous socket',
    )
  }

  return view(registration)
}

/**
 * Removes a device, but only if the socket being closed is still the registered
 * one. Returns whether it removed anything: `false` means a newer connection
 * owns the device and this call was the tail of an old one.
 */
export function unregisterDevice(deviceId: string, socket: DeviceSocketLike): boolean {
  const current = devices.get(deviceId)
  if (current === undefined || current.socket !== socket) return false

  devices.delete(deviceId)
  if (current.sessionId !== null && bySession.get(current.sessionId) === deviceId) {
    bySession.delete(current.sessionId)
  }
  return true
}

export interface DevicePatch {
  caps?: DeviceCaps | null
  agentVersion?: string | null
  sessionId?: string | null
}

/**
 * Applies a `hello`, a session binding or a cap change to the registered device,
 * and refuses if the caller's socket is no longer the current one. Returns
 * whether the patch landed.
 */
export function updateDevice(
  deviceId: string,
  socket: DeviceSocketLike,
  patch: DevicePatch,
): boolean {
  const current = devices.get(deviceId)
  if (current === undefined || current.socket !== socket) return false

  if (patch.caps !== undefined) current.caps = patch.caps
  if (patch.agentVersion !== undefined) current.agentVersion = patch.agentVersion

  if (patch.sessionId !== undefined) {
    if (current.sessionId !== null && bySession.get(current.sessionId) === deviceId) {
      bySession.delete(current.sessionId)
    }
    current.sessionId = patch.sessionId
    if (patch.sessionId !== null) bySession.set(patch.sessionId, deviceId)
  }

  return true
}

/** The device's socket, or `null` when there is none or it is not open. */
export function deviceSocket(deviceId: string): DeviceSocketLike | null {
  const socket = devices.get(deviceId)?.socket
  if (socket === undefined || socket.readyState !== SOCKET_OPEN) return null
  return socket
}

/** The caps the device reported in its `hello`, or `null` before one arrives. */
export const deviceCaps = (deviceId: string): DeviceCaps | null =>
  devices.get(deviceId)?.caps ?? null

/** The session this device's current socket opened, if any. */
export const deviceSession = (deviceId: string): string | null =>
  devices.get(deviceId)?.sessionId ?? null

/** The device that owns a session, if a live socket does. */
export const sessionDevice = (sessionId: string): string | null =>
  bySession.get(sessionId) ?? null

/** A snapshot, oldest connection first. Read-only: the sockets stay here. */
export const listRegisteredDevices = (): RegisteredDevice[] =>
  [...devices.values()].sort((a, b) => a.connectedAt - b.connectedAt).map(view)

/** How many devices hold a socket right now. */
export const connectionCount = (): number => devices.size

/**
 * Pushes one frame to a device. Returns `false` — never throws — when there is
 * no such device, its socket is closed, the message is not a valid `ApiToDevice`
 * frame, or the send itself fails. A caller that needs to know whether the
 * device actually heard it must ask the device, not this function; what `true`
 * means is "handed to a live socket".
 *
 * The frame is validated here as well as at the call sites because this is the
 * last point before the wire, and the one place a bad `ApiToDevice` would reach
 * a device that cannot parse it.
 */
export function sendToDevice(deviceId: string, message: ApiToDeviceMessage): boolean {
  const socket = devices.get(deviceId)?.socket
  if (socket === undefined) return false

  if (socket.readyState !== SOCKET_OPEN) {
    log.debug(
      { deviceId, readyState: socket.readyState },
      'not sending: the device socket is not open',
    )
    return false
  }

  const validated = ApiToDevice.safeParse(message)
  if (!validated.success) {
    log.error(
      { deviceId, issues: validated.error.issues },
      'refused to send an invalid device frame',
    )
    return false
  }

  try {
    socket.send(JSON.stringify(validated.data))
    return true
  } catch (error: unknown) {
    log.warn({ err: error, deviceId }, 'the device socket refused a send')
    return false
  }
}

/**
 * Pushes one frame to whichever device owns a session. What a later row uses to
 * deliver `audio.out`: the caller knows the session, the socket knows the
 * device, and this is the join.
 */
export function sendToSession(sessionId: string, message: ApiToDeviceMessage): boolean {
  const deviceId = bySession.get(sessionId)
  if (deviceId === undefined) return false
  return sendToDevice(deviceId, message)
}

/**
 * This module is a registry, not a route file: a process-local `Map` that
 * `ws/device.ts`, and anything else that wants to push a frame to a device,
 * import directly. It deliberately exports **no** default plugin.
 *
 * It lives in `src/ws/` because HELI-012's `Touches` say so, which the folder
 * loader used to reject by refusing to boot. `plugins/routes.ts` now skips a
 * file with no default export and warns, so a shared module may sit beside the
 * routes that use it — which is where the phase doc puts this one.
 */
