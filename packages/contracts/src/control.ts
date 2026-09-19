import { z } from 'zod'
import { VideoStreamSpec, AudioStreamSpec, AudioOut } from './media.js'

const CommandBase = {
  t: z.literal('command'),
  id: z.string(),
  issuedAt: z.string(),
} as const

export const LedPattern = z.enum(['off', 'breath', 'dot', 'none', 'amplitude', 'amber'])
export type LedPattern = z.infer<typeof LedPattern>

export const DeviceCommand = z.discriminatedUnion('type', [
  z
    .object({
      ...CommandBase,
      type: z.literal('capture'),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('stream.start'),
      payload: z
        .object({
          video: VideoStreamSpec,
          audio: AudioStreamSpec.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('stream.stop'),
      payload: z.object({ reason: z.string().nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('camera.set'),
      payload: z
        .object({
          fps: z.number().positive().nullable(),
          width: z.number().int().positive().nullable(),
          height: z.number().int().positive().nullable(),
          quality: z.number().int().min(1).max(100).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('camera.ptz'),
      payload: z
        .object({
          pan: z.number().nullable(),
          tilt: z.number().nullable(),
          zoom: z.number().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('led.set'),
      payload: z
        .object({
          pattern: LedPattern,
          brightness: z.number().min(0).max(1).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('shutter.set'),
      payload: z.object({ closed: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('speak'),
      payload: AudioOut,
    })
    .strict(),
  z
    .object({
      ...CommandBase,
      type: z.literal('identify'),
      payload: z.object({ durationMs: z.number().int().positive().nullable() }).strict(),
    })
    .strict(),
])
export type DeviceCommand = z.infer<typeof DeviceCommand>

export const CommandAck = z
  .object({
    commandId: z.string(),
    status: z.enum(['done', 'failed']),
    result: z.record(z.unknown()).optional(),
  })
  .strict()
export type CommandAck = z.infer<typeof CommandAck>

export const DeviceTelemetry = z
  .object({
    cpu: z.number().min(0).max(1),
    tempC: z.number(),
    rssi: z.number(),
    uptimeS: z.number().int().nonnegative(),
    fps: z.number().nonnegative(),
    bytesSent: z.number().int().nonnegative(),
  })
  .strict()
export type DeviceTelemetry = z.infer<typeof DeviceTelemetry>
