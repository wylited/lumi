import { z } from 'zod'
import { SpeechProviderName } from './provider.js'

export const MEDIA_TAG = {
  video: 0x01,
  audio: 0x02,
  meta: 0x03,
} as const

export const MediaTag = z.union([
  z.literal(MEDIA_TAG.video),
  z.literal(MEDIA_TAG.audio),
  z.literal(MEDIA_TAG.meta),
])
export type MediaTag = z.infer<typeof MediaTag>

export const VideoStreamSpec = z.object({
  codec: z.literal('jpeg'),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type VideoStreamSpec = z.infer<typeof VideoStreamSpec>

export const AudioStreamSpec = z.object({
  codec: z.literal('pcm_s16le'),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
})
export type AudioStreamSpec = z.infer<typeof AudioStreamSpec>

export const MediaStart = z.object({
  video: VideoStreamSpec,
  audio: AudioStreamSpec,
})
export type MediaStart = z.infer<typeof MediaStart>

export const MediaStopReason = z.enum(['shutter', 'idle', 'user', 'error', 'replaced'])
export type MediaStopReason = z.infer<typeof MediaStopReason>

export const MediaStop = z.object({
  reason: MediaStopReason,
})
export type MediaStop = z.infer<typeof MediaStop>

export const MediaState = z.enum(['idle', 'live'])
export type MediaState = z.infer<typeof MediaState>

export const AudioOut = z.object({
  format: z.literal('pcm_s16le'),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  momentId: z.string(),
})
export type AudioOut = z.infer<typeof AudioOut>

export const MediaFrameMeta = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type MediaFrameMeta = z.infer<typeof MediaFrameMeta>

export const MediaAudioMeta = z.object({
  ts: z.string(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  rms: z.number().nonnegative(),
})
export type MediaAudioMeta = z.infer<typeof MediaAudioMeta>

export const MediaTokenResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
  url: z.string(),
})
export type MediaTokenResponse = z.infer<typeof MediaTokenResponse>

export const MediaStreamState = z.object({
  state: MediaState,
  videoFps: z.number().nonnegative(),
  audioLevel: z.number().nonnegative(),
  audioPlaying: z.boolean(),
  speechQueueDepth: z.number().int().nonnegative(),
  lastFrameAt: z.string().nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
})
export type MediaStreamState = z.infer<typeof MediaStreamState>

export const MediaControlMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }).extend(MediaStreamState.shape),
  z.object({ type: z.literal('frame') }).extend(MediaFrameMeta.shape),
  z.object({ type: z.literal('audio') }).extend(MediaAudioMeta.shape),
  z.object({ type: z.literal('bargein'), ts: z.string() }),
])
export type MediaControlMessage = z.infer<typeof MediaControlMessage>

/**
 * The speech bridge. `local` needs no credentials so the device -> loop ->
 * `audio.out` path is always exercisable; `elevenlabs` is key gated.
 */
export const SpeechSynthesisRequest = z.object({
  text: z.string().min(1).max(500),
  voice: z.string().nullable().default(null),
  language: z.string().default('en'),
})
export type SpeechSynthesisRequest = z.infer<typeof SpeechSynthesisRequest>

export const SpeechSynthesisResult = z.object({
  provider: SpeechProviderName,
  sampleRate: z.number().int().positive(),
  channels: z.number().int().min(1).max(2),
  durationMs: z.number().int().nonnegative(),
  /** Base64 PCM S16LE. */
  pcmBase64: z.string().nullable(),
})
export type SpeechSynthesisResult = z.infer<typeof SpeechSynthesisResult>
