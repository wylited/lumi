import { z } from 'zod'

export const DeviceState = z.enum([
  'idle',
  'armed',
  'watching',
  'flagged',
  'speaking',
  'shutter_closed',
])
export type DeviceState = z.infer<typeof DeviceState>

export const DeviceTransport = z.enum(['ws', 'mjpeg', 'webrtc'])
export type DeviceTransport = z.infer<typeof DeviceTransport>

export const DeviceResolution = z.tuple([z.number().int().positive(), z.number().int().positive()])
export type DeviceResolution = z.infer<typeof DeviceResolution>

export const DeviceCaps = z.object({
  camera: z.string(),
  mics: z.number().int().nonnegative(),
  speaker: z.boolean(),
  shutter: z.boolean(),
  ptz: z.boolean(),
  transports: z.array(DeviceTransport),
  audio: z.boolean(),
  resolutions: z.array(DeviceResolution),
  fps: z.array(z.number().positive()),
})
export type DeviceCaps = z.infer<typeof DeviceCaps>

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  caps: DeviceCaps,
  state: DeviceState.nullable(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
})
export type Device = z.infer<typeof Device>
