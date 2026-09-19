import { pino } from 'pino'

import type {
  SpeechProviderName,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@heli/contracts'

import type { SpeechProvider } from '../observe/types.js'

/**
 * Speech out. The `local` adapter needs no credentials and produces real
 * 16 kHz mono S16LE PCM, so the whole device -> loop -> `audio.out` path is
 * exercisable offline. The hosted adapter is key gated and fails with a
 * sentence naming the variable a human must set.
 *
 * The provider key never leaves this module family.
 */

const SAMPLE_RATE = 16_000
const CHANNELS = 1
const MAX_TEXT_LENGTH = 500

// Roughly 60 ms per character, clamped so a one-word line is still audible and
// a runaway string cannot hold the speaker for minutes.
const MS_PER_CHARACTER = 60
const MIN_DURATION_MS = 400
const MAX_DURATION_MS = 8_000

const env = {
  SPEECH_PROVIDER: (process.env.SPEECH_PROVIDER ?? 'local') as SpeechProviderName,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
}

const log = pino({ level: env.LOG_LEVEL, name: 'speech' })

// What `createSpeechProvider` needs from the process environment. Kept structural
// so the real server env can be passed without this module importing it.
export interface SpeechEnv {
  SPEECH_PROVIDER?: SpeechProviderName
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_VOICE_ID?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Bytes of S16LE PCM map to milliseconds at a given rate and channel count. */
export function pcmDurationMs(bytes: number, sampleRate: number, channels: number): number {
  return Math.round((bytes / (sampleRate * channels * 2)) * 1000)
}

function durationForText(text: string): number {
  return clamp(Math.round(text.length * MS_PER_CHARACTER), MIN_DURATION_MS, MAX_DURATION_MS)
}

/**
 * A spoken-sounding local envelope: a short sequence of tones whose total
 * duration tracks the text, with a fade at each end so it does not click. It is
 * deliberately not intelligible; it exists so the path runs with no key.
 */
function localPcm(text: string): Buffer {
  const durationMs = durationForText(text)
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1000)
  const out = Buffer.alloc(frames * 2)

  const tones = [196, 233, 262, 220] // a small falling/rising motif
  const segmentMs = 180
  const fadeFrames = Math.max(1, Math.round(SAMPLE_RATE * 0.025))

  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE
    const segment = Math.min(tones.length - 1, Math.floor((t * 1000) / segmentMs))
    const freq = tones[segment] ?? tones[0] ?? 220

    let envelope = 1
    if (i < fadeFrames) envelope = i / fadeFrames
    else if (i >= frames - fadeFrames) envelope = (frames - i) / fadeFrames

    // A slow wobble keeps it from reading as a test tone.
    const wobble = 0.85 + 0.15 * Math.sin(2 * Math.PI * 5.5 * t)
    const sample = Math.round(envelope * 0.4 * 32767 * wobble * Math.sin(2 * Math.PI * freq * t))
    out.writeInt16LE(clamp(sample, -32768, 32767), i * 2)
  }

  return out
}

class LocalSpeechProvider implements SpeechProvider {
  readonly name = 'local' as const

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    enforceMaxLength(request.text)
    const started = performance.now()
    const pcm = localPcm(request.text)
    const durationMs = durationForText(request.text)

    log.info(
      {
        provider: 'local',
        textLength: request.text.length,
        durationMs,
        latencyMs: Math.round(performance.now() - started),
      },
      'speech: synthesized locally',
    )

    return {
      provider: 'local',
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs,
      pcmBase64: pcm.toString('base64'),
    }
  }
}

class ElevenLabsSpeechProvider implements SpeechProvider {
  readonly name = 'elevenlabs' as const

  constructor(private readonly config: SpeechEnv) {}

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    enforceMaxLength(request.text)

    const apiKey = this.config.ELEVENLABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY is required for the elevenlabs speech provider')
    }
    const voiceId = request.voice ?? this.config.ELEVENLABS_VOICE_ID
    if (!voiceId) {
      throw new Error(
        'ELEVENLABS_VOICE_ID is required for the elevenlabs speech provider, or pass request.voice',
      )
    }

    const started = performance.now()
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      '?output_format=pcm_16000'
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: 'eleven_flash_v2_5',
        language_code: request.language,
      }),
    })
    if (!response.ok) {
      throw new Error(`ElevenLabs synthesis failed with HTTP ${response.status}`)
    }

    const pcm = Buffer.from(await response.arrayBuffer())
    const durationMs = pcmDurationMs(pcm.length, SAMPLE_RATE, CHANNELS)

    log.info(
      {
        provider: 'elevenlabs',
        textLength: request.text.length,
        durationMs,
        latencyMs: Math.round(performance.now() - started),
      },
      'speech: synthesized via elevenlabs',
    )

    return {
      provider: 'elevenlabs',
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs,
      pcmBase64: pcm.toString('base64'),
    }
  }
}

function enforceMaxLength(text: string): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`speech text exceeds the ${MAX_TEXT_LENGTH} character limit`)
  }
}

export function createSpeechProvider(config: SpeechEnv = env): SpeechProvider {
  switch (config.SPEECH_PROVIDER ?? 'local') {
    case 'elevenlabs':
      return new ElevenLabsSpeechProvider(config)
    case 'local':
    default:
      log.info({ provider: 'local' }, 'speech: using the local offline provider')
      return new LocalSpeechProvider()
  }
}
