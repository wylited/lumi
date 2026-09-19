import { z } from 'zod'
import { DeviceCaps, DeviceState, DeviceTransport } from './device.js'
import { Goal } from './goal.js'
import { Policy } from './policy.js'
import { MediaStart, MediaStop, MediaState, AudioOut } from './media.js'
import { DeviceCommand, CommandAck, DeviceTelemetry } from './control.js'

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
