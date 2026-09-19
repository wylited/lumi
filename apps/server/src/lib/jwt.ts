import jwt from 'jsonwebtoken'
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'

import { env } from '../env.js'

/**
 * The two identities this server knows. A browser or the desktop app carries a
 * *user* token; the Pi carries a *device* token. They are signed with the same
 * key but stamped with a `typ`, and each verifier refuses the other's tokens, so
 * a device token can never be replayed against a `/v1/...` route that expects a
 * person.
 */
export interface UserClaims {
  userId: string
}

export interface DeviceClaims {
  deviceId: string
}

const ISSUER = 'heli'
const ALGORITHM = 'HS256'
const USER_TYP = 'user'
const DEVICE_TYP = 'device'
const DESK_TYP = 'desk'

// 12h for a person at a keyboard; 90d for a Pi that is screwed to a desk and
// should survive a weekend without a re-pair. The desk token is the rig's, which
// is a headless process on the same machine as the user — long-lived for the same
// reason, and re-running setup rotates it.
const USER_TTL_SECONDS = 12 * 60 * 60
const DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60

interface TokenPayload {
  sub: string
  typ: typeof USER_TYP | typeof DEVICE_TYP | typeof DESK_TYP
}

/**
 * Fails a request the way `plugins/errors.ts` documents: an Error carrying a
 * `statusCode`, which the error handler turns into `{ error: message }`. A 4xx
 * message is passed through to the client verbatim, so it must never contain
 * anything the caller should not see.
 */
const unauthorized = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 401 })

const sign = (payload: TokenPayload, ttlSeconds: number): string =>
  jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    expiresIn: ttlSeconds,
  })

/** A 12h token for a signed-in person. `sub` is the user's id. */
export const signUserToken = (userId: string): string =>
  sign({ sub: userId, typ: USER_TYP }, USER_TTL_SECONDS)

/** A 90d token for a paired device. `sub` is the device's id. */
export const signDeviceToken = (deviceId: string): string =>
  sign({ sub: deviceId, typ: DEVICE_TYP }, DEVICE_TTL_SECONDS)

/**
 * Verifies signature, issuer and expiry, then checks the `typ` claim. `sub` is
 * the only thing the callers need, so it is the only thing returned.
 */
const subjectOf = (token: string, expectedType: TokenPayload['typ']): string => {
  let decoded: unknown
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
    })
  } catch {
    // Expired, tampered, wrong issuer, wrong algorithm: all one answer to the
    // client. Which of them it was goes nowhere, on purpose.
    throw unauthorized('Invalid or expired token')
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw unauthorized('Invalid token payload')
  }

  const { sub, typ } = decoded as { sub?: unknown; typ?: unknown }
  if (typeof sub !== 'string' || sub.length === 0) {
    throw unauthorized('Invalid token payload')
  }
  if (typ !== expectedType) {
    // A device token presented as a user token (or the reverse) is a
    // programming error on the caller's side, and reads as such.
    throw unauthorized(`This endpoint needs a ${expectedType} token`)
  }

  return sub
}

export const verifyUserToken = (token: string): string => subjectOf(token, USER_TYP)

export const verifyDeviceToken = (token: string): string => subjectOf(token, DEVICE_TYP)

/**
 * A 90d token for the rig. `sub` is the desk's id.
 *
 * The rig is a headless process, so it cannot hold the user's credentials: this
 * is what `POST /v1/desks` hands it, and what `/ws/desk` and the frame upload
 * authenticate with instead. Because every verifier checks `typ`, a desk token
 * cannot be replayed against a route that expects a person, and a stolen user
 * token cannot be used to impersonate a desk.
 */
export const signDeskToken = (deskId: string): string =>
  sign({ sub: deskId, typ: DESK_TYP }, DEVICE_TTL_SECONDS)

export const verifyDeskToken = (token: string): string => subjectOf(token, DESK_TYP)

/**
 * Reads the token out of an `Authorization: Bearer <token>` header. Returns
 * `null` for a missing header, another scheme, or an empty token — all of which
 * the callers report as a 401 rather than as a malformed request.
 */
export const bearerToken = (header: string | undefined): string | null => {
  if (!header) return null
  const separator = header.indexOf(' ')
  if (separator === -1) return null
  if (header.slice(0, separator).toLowerCase() !== 'bearer') return null
  const token = header.slice(separator + 1).trim()
  return token.length > 0 ? token : null
}

/**
 * `requireUser` and `requireDevice` are exported preHandler *hooks*, not
 * `app.decorate`d methods. A decorator added inside a route-file plugin lands in
 * that plugin's encapsulation context and is invisible to every sibling route
 * file the folder loader registers next, which is exactly the bug this avoids.
 *
 * Each one throws on failure, so a protected route body only ever runs with
 * `request.userId` (or `request.deviceId`) set.
 */
export const requireUser: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
  const token = bearerToken(request.headers.authorization)
  if (!token) throw unauthorized('A bearer token is required')
  request.userId = verifyUserToken(token)
}

export const requireDevice: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
  const token = bearerToken(request.headers.authorization)
  if (!token) throw unauthorized('A bearer token is required')
  request.deviceId = verifyDeviceToken(token)
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser`. Absent on every unprotected route. */
    userId?: string
    /** Set by `requireDevice`. Absent on every unprotected route. */
    deviceId?: string
  }
}
