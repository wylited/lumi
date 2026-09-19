import { randomInt } from 'node:crypto'

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import {
  DeviceListResponse,
  DeviceState,
  DeviceTransport,
  PairDeviceRequest,
  PairDeviceResponse,
  RotateCodeResponse,
} from '@heli/contracts'
import type { Device as ApiDevice, DeviceCaps } from '@heli/contracts'
import type { Device as DeviceRow } from '@prisma/client'

import { requireUser, signDeviceToken } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

/**
 * How long after its last contact a device still counts as online.
 *
 * The device contract has the Pi reporting telemetry and answering a heartbeat
 * every 20 s, so 90 s is four missed beats — long enough to ride out a Wi-Fi
 * stutter, short enough that a yanked cable shows up while someone is looking at
 * the screen. HELI-012 keeps `Device.lastSeenAt` fresh while a socket is up, and
 * every route in P1 derives `online` from it, so there is exactly one definition
 * of "online" in the codebase.
 */
const ONLINE_WINDOW_MS = 90_000

const SEEDED_USER_MISSING =
  'No user in the database. Run `pnpm --filter @heli/server db:seed` and retry.'

const fail = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode })

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

const isTransport = (value: unknown): value is DeviceTransport =>
  DeviceTransport.safeParse(value).success

const isResolution = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((edge) => typeof edge === 'number' && Number.isInteger(edge) && edge > 0)

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The seed writes `{ camera: true, mic: true, speaker: true, led: true, ptz:
 * false }`, which is not the contract's `DeviceCaps` in any field — `camera` is
 * a model string, `mics` is a count, and the contract wants `audio`, `shutter`,
 * `transports`, `resolutions` and `fps` that the seed never mentions.
 *
 * Two ways out: change the seed (nobody in P1 owns `prisma/seed.ts`, it is
 * frozen) or coerce with a fallback here. This is the coercion. It is
 * deliberately forgiving — a device row from any era, real or seeded, produces a
 * caps object that satisfies the contract — and it never invents hardware: an
 * absent resolution list stays empty rather than becoming a plausible lie.
 */
export function toApiCaps(raw: unknown): DeviceCaps {
  const caps = asObject(raw)

  // A real device reports a model string. The seed's `true` means "there is a
  // camera and we do not know which one", which is exactly 'unknown'.
  const camera =
    typeof caps.camera === 'string' && caps.camera.length > 0
      ? caps.camera
      : caps.camera === true
        ? 'unknown'
        : 'none'

  const mics = asCount(caps.mics) ?? asCount(caps.mic) ?? (caps.mic === true ? 1 : 0)

  const rawTransports: unknown[] = Array.isArray(caps.transports) ? caps.transports : []
  const transports = rawTransports.filter(isTransport)

  const rawResolutions: unknown[] = Array.isArray(caps.resolutions) ? caps.resolutions : []
  const rawFps: unknown[] = Array.isArray(caps.fps) ? caps.fps : []

  return {
    camera,
    mics,
    speaker: asBool(caps.speaker, false),
    shutter: asBool(caps.shutter, false),
    ptz: asBool(caps.ptz, false),
    // A device that reached this server at all speaks `ws`. An empty list would
    // hide the stream control in the UI for reasons nobody could act on.
    transports: transports.length > 0 ? transports : ['ws'],
    // `audio` in the seed is implicit in `mic`, so fall back to the mic count.
    audio: asBool(caps.audio, mics > 0),
    resolutions: rawResolutions.filter(isResolution),
    fps: rawFps.filter(isPositive),
  }
}

/**
 * The one place a `Device` row becomes a contract `Device`.
 *
 * `state` is a free-form string column and the contract wants a six-value enum,
 * so an unrecognised value becomes `null` ("we do not know") rather than a 500
 * from the response serializer.
 */
export function toApiDevice(row: DeviceRow): ApiDevice {
  const state = DeviceState.safeParse(row.state)

  return {
    id: row.id,
    name: row.name,
    caps: toApiCaps(row.caps),
    state: state.success ? state.data : null,
    online: row.lastSeenAt !== null && Date.now() - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Stamps a device as having just been heard from. HELI-012 calls this on every
 * socket message so `online` above stays true for a connected device, and a
 * heartbeat alone is enough to keep it that way.
 */
export async function touchDevice(deviceId: string, at: Date = new Date()): Promise<void> {
  await prisma.device.updateMany({ where: { id: deviceId }, data: { lastSeenAt: at } })
}

// `I`, `O`, `0` and `1` are out: a pairing code gets read off a screen and typed
// into a phone or a Pi's config, and those four are where that goes wrong.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

const generateCode = (): string => {
  let suffix = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    suffix += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length))
  }
  return `HELI-${suffix}`
}

/** A code no device currently holds. `code` is unique in the schema. */
const freshCode = async (): Promise<string> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateCode()
    const clash = await prisma.device.findUnique({ where: { code }, select: { id: true } })
    if (!clash) return code
  }
  throw fail(500, 'Could not generate an unused pairing code')
}

const devices: FastifyPluginAsync = async (app) => {
  /**
   * Idempotent on purpose: the Pi retries this on every boot and every network
   * blip, and each retry must land on the same device row rather than minting a
   * second one. The token is fresh each time; the device and its `pairedAt` are
   * not.
   *
   * Unauthenticated, because the caller is a device that has a pairing code and
   * nothing else — it has no user token to present. The code *is* the credential.
   */
  app.post(
    '/v1/devices/pair',
    {
      schema: {
        body: PairDeviceRequest,
        response: { 200: PairDeviceResponse },
      },
    },
    async (request): Promise<PairDeviceResponse> => {
      const row = await prisma.device.findUnique({ where: { code: request.body.code } })
      // Deliberately does not echo the submitted code back: it is a credential,
      // and an error body travels further than a request line.
      if (!row) throw fail(404, 'Unknown pairing code')

      const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
      if (!user) throw fail(503, SEEDED_USER_MISSING)

      const paired = await prisma.device.update({
        where: { id: row.id },
        data: {
          // Binds once. A re-pair must not steal a device from the user it is
          // already bound to.
          userId: row.userId ?? user.id,
          pairedAt: row.pairedAt ?? new Date(),
        },
      })

      return { device: toApiDevice(paired), deviceToken: signDeviceToken(paired.id) }
    },
  )

  /** The app's device list. A browser route, so it needs a user token. */
  app.get(
    '/v1/devices',
    {
      preHandler: requireUser,
      schema: { response: { 200: DeviceListResponse } },
    },
    async (): Promise<ApiDevice[]> => {
      const rows = await prisma.device.findMany({ orderBy: { createdAt: 'asc' } })
      return rows.map(toApiDevice)
    },
  )

  /**
   * Invalidates the old code by replacing it. Because `code` is unique, the
   * previous value stops resolving the moment this lands — which is the whole
   * point of rotating one.
   */
  app.post(
    '/v1/devices/:id/rotate-code',
    {
      preHandler: requireUser,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: RotateCodeResponse },
      },
    },
    async (request): Promise<RotateCodeResponse> => {
      const { id } = request.params
      const row = await prisma.device.findUnique({ where: { id }, select: { id: true } })
      if (!row) throw fail(404, `No device with id ${id}`)

      const updated = await prisma.device.update({
        where: { id },
        data: { code: await freshCode() },
        select: { id: true, code: true },
      })

      return { deviceId: updated.id, code: updated.code }
    },
  )
}

export default devices
