import { pino } from 'pino'

import type {
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from '@heli/contracts'

import type { SpeechProvider } from '../observe/types.js'

/**
 * Speech out, through ElevenLabs as 16 kHz mono S16LE PCM. There is no offline
 * voice: a missing key fails with a sentence naming the variable to set.
 *
 * The provider key never leaves this module family.
 */

const SAMPLE_RATE = 16_000
const CHANNELS = 1
const MAX_TEXT_LENGTH = 500

const env = {
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
}

const log = pino({ level: env.LOG_LEVEL, name: 'speech' })

// What `createSpeechProvider` needs from the process environment. Kept structural
// so the real server env can be passed without this module importing it.
export interface SpeechEnv {
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_VOICE_ID?: string
}

/** Bytes of S16LE PCM map to milliseconds at a given rate and channel count. */
export function pcmDurationMs(bytes: number, sampleRate: number, channels: number): number {
  return Math.round((bytes / (sampleRate * channels * 2)) * 1000)
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
  if (!config.ELEVENLABS_API_KEY?.trim()) {
    throw new Error('ELEVENLABS_API_KEY is not set: Lumi has no voice without it (apps/server/.env)')
  }
  if (!config.ELEVENLABS_VOICE_ID?.trim()) {
    throw new Error('ELEVENLABS_VOICE_ID is not set: pick a voice in apps/server/.env')
  }
  return new ElevenLabsSpeechProvider(config)
}
