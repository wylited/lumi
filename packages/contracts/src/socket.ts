import { z } from 'zod'
import { DeviceCaps, DeviceState, DeviceTransport } from './device.js'
import { Goal } from './goal.js'
import { Policy } from './policy.js'
import { MediaStart, MediaStop, MediaState, AudioOut } from './media.js'
import { DeviceCommand, CommandAck, DeviceTelemetry } from './control.js'
import { SignalBatch } from './signal.js'

export const HELI_SOCKET_PROTOCOL = 'heli.v1'

export const DeviceHello = z
  .object({
    t: z.literal('hello'),
    deviceId: z.string(),
    agentVersion: z.string(),
    caps: DeviceCaps,
  })
  .strict()
export type DeviceHello = z.infer<typeof DeviceHello>

export const DeviceSessionOpen = z
  .object({
    t: z.literal('session.open'),
    goalId: z.string().nullable(),
  })
  .strict()
export type DeviceSessionOpen = z.infer<typeof DeviceSessionOpen>

export const DeviceFrame = z
  .object({
    t: z.literal('frame'),
    seq: z.number().int().nonnegative(),
    ts: z.string(),
    trigger: z.string(),
  })
  .strict()
export type DeviceFrame = z.infer<typeof DeviceFrame>

export const DeviceMediaStart = z
  .object({ t: z.literal('media.start') })
  .extend(MediaStart.shape)
  .strict()
export type DeviceMediaStart = z.infer<typeof DeviceMediaStart>

export const DeviceMediaStop = z
  .object({ t: z.literal('media.stop') })
  .extend(MediaStop.shape)
  .strict()
export type DeviceMediaStop = z.infer<typeof DeviceMediaStop>

export const DeviceMediaState = z
  .object({
    t: z.literal('media.state'),
    state: MediaState,
  })
  .strict()
export type DeviceMediaState = z.infer<typeof DeviceMediaState>

export const DeviceStateMessage = z
  .object({
    t: z.literal('state'),
    state: DeviceState,
  })
  .strict()
export type DeviceStateMessage = z.infer<typeof DeviceStateMessage>

export const DeviceTelemetryMessage = z
  .object({ t: z.literal('telemetry') })
  .extend(DeviceTelemetry.shape)
  .strict()
export type DeviceTelemetryMessage = z.infer<typeof DeviceTelemetryMessage>

export const DeviceCommandAck = z
  .object({ t: z.literal('command.ack') })
  .extend(CommandAck.shape)
  .strict()
export type DeviceCommandAck = z.infer<typeof DeviceCommandAck>

export const DeviceStreamInfo = z
  .object({
    t: z.literal('stream.info'),
    transport: DeviceTransport,
    url: z.string(),
  })
  .strict()
export type DeviceStreamInfo = z.infer<typeof DeviceStreamInfo>

export const DeviceBargein = z
  .object({
    t: z.literal('bargein'),
    ts: z.string(),
  })
  .strict()
export type DeviceBargein = z.infer<typeof DeviceBargein>

export const DeviceSessionClose = z
  .object({
    t: z.literal('session.close'),
    reason: z.string(),
  })
  .strict()
export type DeviceSessionClose = z.infer<typeof DeviceSessionClose>

export const DeviceToApi = z.discriminatedUnion('t', [
  DeviceHello,
  DeviceSessionOpen,
  DeviceFrame,
  DeviceMediaStart,
  DeviceMediaStop,
  DeviceMediaState,
  DeviceStateMessage,
  DeviceTelemetryMessage,
  DeviceCommandAck,
  DeviceStreamInfo,
  DeviceBargein,
  DeviceSessionClose,
])
export type DeviceToApi = z.infer<typeof DeviceToApi>

export const ApiSessionStart = z
  .object({
    t: z.literal('session.start'),
    sessionId: z.string(),
    goal: Goal,
    policy: Policy,
  })
  .strict()
export type ApiSessionStart = z.infer<typeof ApiSessionStart>

export const ApiAudioOut = z
  .object({ t: z.literal('audio.out') })
  .extend(AudioOut.shape)
  .strict()
export type ApiAudioOut = z.infer<typeof ApiAudioOut>

export const ApiPolicyUpdate = z
  .object({ t: z.literal('policy.update') })
  .extend(Policy.shape)
  .strict()
export type ApiPolicyUpdate = z.infer<typeof ApiPolicyUpdate>

export const ApiError = z
  .object({
    t: z.literal('error'),
    code: z.string(),
    message: z.string(),
    ref: z.string().optional(),
  })
  .strict()
export type ApiError = z.infer<typeof ApiError>

export const ApiSessionStop = z
  .object({
    t: z.literal('session.stop'),
    reason: z.string(),
  })
  .strict()
export type ApiSessionStop = z.infer<typeof ApiSessionStop>

export const ApiToDevice = z.union([
  ApiSessionStart,
  ApiAudioOut,
  DeviceCommand,
  ApiPolicyUpdate,
  ApiError,
  ApiSessionStop,
])
export type ApiToDevice = z.infer<typeof ApiToDevice>

/* ---- the desktop socket -------------------------------------------------- */

/**
 * `wss://api/ws/desktop`, protocol `heli.v1` — see `docs/01-contracts.md` §8.
 *
 * The desktop watches the machine, the device watches the desk, and both may be
 * offline or online, so both get a socket and a batched HTTP fallback. The
 * desktop's socket is a way *in*: observations, interventions and windows reach
 * it over SSE, so there is nothing here for the server to push except an ack.
 */

export const DesktopHello = z
  .object({
    t: z.literal('hello'),
    appVersion: z.string(),
    /** The machine being watched, when the desktop knows which one it is. */
    deviceId: z.string().nullable(),
    /** The session to fold live signals into, when one is open. */
    sessionId: z.string().nullable(),
  })
  .strict()
export type DesktopHello = z.infer<typeof DesktopHello>

/**
 * Deliberately `SignalBatch` verbatim rather than a shape of its own.
 *
 * The same signals arrive at `POST /v1/signals` when the desktop was offline, so
 * a socket-only payload would be a second definition of the same thing and the
 * two would drift — which is exactly the failure the `Touches` rule exists to
 * prevent, one layer down.
 */
export const DesktopSignals = z
  .object({ t: z.literal('signals') })
  .extend(SignalBatch.shape)
  .strict()
export type DesktopSignals = z.infer<typeof DesktopSignals>

/** The desktop's own playback state, and the only other thing it may write. */
export const DesktopPlayback = z
  .object({
    t: z.literal('playback'),
    playing: z.boolean(),
    momentId: z.string().nullable(),
  })
  .strict()
export type DesktopPlayback = z.infer<typeof DesktopPlayback>

export const DesktopToApi = z.discriminatedUnion('t', [
  DesktopHello,
  DesktopSignals,
  DesktopPlayback,
])
export type DesktopToApi = z.infer<typeof DesktopToApi>

/** How many signals of a batch landed. Mirrors `SignalBatchResponse`. */
export const DesktopAck = z
  .object({
    t: z.literal('ack'),
    accepted: z.number().int().nonnegative(),
  })
  .strict()
export type DesktopAck = z.infer<typeof DesktopAck>

/**
 * A tier-2 intervention, where the person actually is.
 *
 * The desktop decides how it appears — a native notification with one action,
 * never a bare toast — and whether the person acted on it, which it reports back
 * on the ordinary signal transport so the policy can judge the outcome.
 */
export const ApiNudge = z
  .object({
    t: z.literal('nudge'),
    /** The observation this nudges about, so the outcome can be attributed. */
    observationId: z.string().nullable().default(null),
    message: z.string().min(1).max(220),
    action: z.enum(['back_to_goal', 'snooze_10m']).nullable().default(null),
  })
  .strict()
export type ApiNudge = z.infer<typeof ApiNudge>

/**
 * A union rather than a discriminated union on purpose: `ApiError` is the one
 * shape both sockets share with the device, and wrapping it would mean two
 * error types to keep in step.
 */
export const ApiToDesktop = z.union([DesktopAck, ApiAudioOut, ApiNudge, ApiError])
export type ApiToDesktop = z.infer<typeof ApiToDesktop>
