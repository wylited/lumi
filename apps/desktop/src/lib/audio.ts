/**
 * Tier-3 audio. The server's speech bridge sends PCM (S16LE, base64); `PcmPlayer` plays it through
 * Web Audio, the same shape the web uses, resumed on the first user gesture. When a line arrives
 * as text only (the local adapter, or the demo), the system voice reads it.
 *
 * Stop is barge-in: playback ends at once and the stop is reported. There is no desktop→server
 * message for it in the contract yet (`DesktopToApi` is missing), so the report goes to
 * `onBargein` listeners and the log until it exists.
 */
import { useSyncExternalStore } from 'react'
import { logger } from './log'

const log = logger('audio')

class PcmPlayer {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null

  private context(): AudioContext {
    this.ctx ??= new AudioContext()
    return this.ctx
  }

  /** Browsers start audio suspended until a gesture; call this from any click. */
  resume(): void {
    void this.context().resume()
  }

  /** PCM S16LE, interleaved. */
  play(bytes: Uint8Array, sampleRate: number, channels: number, onEnd: () => void): void {
    const copy = bytes.slice() // aligned, and ours
    const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.byteLength / 2))
    const frames = Math.floor(samples.length / channels)
    const ctx = this.context()
    const buffer = ctx.createBuffer(channels, frames, sampleRate)
    for (let c = 0; c < channels; c += 1) {
      const out = buffer.getChannelData(c)
      for (let i = 0; i < frames; i += 1) out[i] = (samples[i * channels + c] ?? 0) / 32768
    }
    this.stop()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.onended = onEnd
    src.start()
    this.source = src
  }

  stop(): void {
    try {
      this.source?.stop()
    } catch {
      // already stopped
    }
    this.source = null
  }
}

const player = new PcmPlayer()

interface AudioState {
  speaking: string | null
  muted: boolean
}

let state: AudioState = { speaking: null, muted: false }
const listeners = new Set<() => void>()
const bargeinListeners = new Set<(line: string) => void>()
const playbackListeners = new Set<(playing: boolean, line: string) => void>()

function set(next: Partial<AudioState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const audio = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  resume: () => player.resume(),

  /**
   * Speak a line. With `pcm`, play exactly those samples (the server's voice); without, the system
   * voice reads the text (the demo, and the local adapter).
   */
  say(line: string, pcm?: { bytes: Uint8Array; sampleRate: number; channels: number }): boolean {
    if (state.muted) {
      log.info('muted, line not played', line)
      return false
    }
    set({ speaking: line })
    playbackListeners.forEach((l) => l(true, line))
    const done = () => {
      if (state.speaking !== line) return
      set({ speaking: null })
      playbackListeners.forEach((l) => l(false, line))
    }
    if (pcm) {
      player.play(pcm.bytes, pcm.sampleRate, pcm.channels, done)
    } else if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(line)
      u.rate = 1.02
      u.onend = done
      u.onerror = done
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    } else {
      log.warn('no audio path available')
      done()
      return false
    }
    return true
  },

  /** The person spoke over it, or pressed stop. */
  stop(): void {
    const line = state.speaking
    player.stop()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    set({ speaking: null })
    if (line) {
      log.info('barge-in', line)
      bargeinListeners.forEach((l) => l(line))
      playbackListeners.forEach((l) => l(false, line))
    }
  },

  setMuted(muted: boolean): void {
    if (muted) audio.stop()
    set({ muted })
  },

  onBargein(l: (line: string) => void) {
    bargeinListeners.add(l)
    return () => bargeinListeners.delete(l)
  },

  /** Every start and every stop — natural end or barge-in. The socket reports these. */
  onPlayback(l: (playing: boolean, line: string) => void) {
    playbackListeners.add(l)
    return () => playbackListeners.delete(l)
  },
}

export function useAudio(): AudioState {
  return useSyncExternalStore(audio.subscribe, audio.get)
}
