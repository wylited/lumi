import { ApiToMobile, HELI_SOCKET_PROTOCOL, MEDIA_TAG, PHONE_SIGNAL, type Signal } from '@heli/contracts'
import { Platform } from 'react-native'

import { APP_VERSION, postSignals, socketUrl } from './api'
import { playLine, stopLine } from './audio'
import { showNudge } from './notify'
import type { SignalSampler } from './signals'

/**
 * The phone's socket: hello, signals up, nudges and speech down.
 *
 * It reconnects with backoff, keeps collecting while it is down, and flushes the
 * backlog over HTTP when the socket stays away — a phone that spent the last
 * hour in a lift still contributes its hour when it comes back. The server
 * decides which session the batch belongs to; the phone never sends a session
 * id, because it is never told one it could forge.
 */

export interface Nudge {
  message: string
  observationId: string | null
  action: 'back_to_goal' | 'snooze_10m' | null
}

export interface PhoneSocket {
  start(): void
  stop(): void
  /** The person's answer to a nudge, on the same bus the desktop uses. */
  respond(action: 'back_to_goal' | 'snooze_10m' | 'dismiss', observationId: string | null): void
  readonly connected: boolean
}

const FLUSH_MS = 5_000
const HTTP_FLUSH_EVERY = 6
const MAX_BACKOFF_MS = 15_000

export function createPhoneSocket(input: {
  serverUrl: string
  token: string
  phoneName: string
  sampler: SignalSampler
  onState: (state: 'connecting' | 'open' | 'closed') => void
  onNudge: (nudge: Nudge) => void
  onPlaying: (playing: boolean) => void
  onNotice: (message: string) => void
}): PhoneSocket {
  let ws: WebSocket | null = null
  let stopped = false
  let backoffMs = 1_000
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let ticks = 0
  let connected = false
  let pendingAudio: { momentId: string; sampleRate: number; channels: number; durationMs: number } | null =
    null
  /** Signals that must go even if the sampler has nothing (a nudge answer). */
  const outbox: Signal[] = []

  const send = (message: unknown): boolean => {
    if (ws === null || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  const sendPlayback = (playing: boolean): void => {
    send({ t: 'playback', playing, momentId: pendingAudio?.momentId ?? null })
  }

  const flush = async (): Promise<void> => {
    ticks += 1
    const signals = [...outbox.splice(0, outbox.length), ...(await input.sampler.collect())]
    if (signals.length === 0) return

    if (send({ t: 'signals', signals })) return

    // The socket is down. Try the HTTP path every sixth tick, and put the batch
    // back if even that fails — the sampler's cap keeps it bounded.
    if (ticks % HTTP_FLUSH_EVERY !== 0) {
      outbox.unshift(...signals)
      return
    }
    try {
      await postSignals(input.serverUrl, input.token, signals)
      input.onNotice(`flushed ${signals.length} signals over HTTP`)
    } catch {
      outbox.unshift(...signals)
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped) return
    const wait = Math.min(backoffMs, MAX_BACKOFF_MS)
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    setTimeout(connect, wait)
  }

  function connect(): void {
    if (stopped) return
    input.onState('connecting')

    const socket = new WebSocket(socketUrl(input.serverUrl), [HELI_SOCKET_PROTOCOL, input.token])
    socket.binaryType = 'arraybuffer'
    ws = socket

    socket.onopen = () => {
      backoffMs = 1_000
      connected = true
      input.onState('open')
      send({
        t: 'hello',
        appVersion: APP_VERSION,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        name: input.phoneName,
        sessionId: null,
      })
      void flush()
    }

    socket.onmessage = (event: WebSocketMessageEvent) => {
      const data = event.data

      if (typeof data === 'string') {
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          return
        }
        const parsed = ApiToMobile.safeParse(json)
        if (!parsed.success) return

        switch (parsed.data.t) {
          case 'nudge': {
            // A new instruction supersedes the line being spoken.
            stopLine()
            input.onNudge({
              message: parsed.data.message,
              observationId: parsed.data.observationId,
              action: parsed.data.action,
            })
            void showNudge(parsed.data.message)
            return
          }
          case 'audio.out': {
            pendingAudio = {
              momentId: parsed.data.momentId,
              sampleRate: parsed.data.sampleRate,
              channels: parsed.data.channels,
              durationMs: parsed.data.durationMs,
            }
            return
          }
          case 'error': {
            input.onNotice(parsed.data.message)
            return
          }
          case 'ack':
            return
        }
      }

      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null
      if (bytes === null || pendingAudio === null) return
      if (bytes[0] !== MEDIA_TAG.audio) {
        pendingAudio = null
        return
      }

      const header = pendingAudio
      pendingAudio = null
      void playLine(
        {
          format: 'pcm_s16le',
          sampleRate: header.sampleRate,
          channels: header.channels,
          durationMs: header.durationMs,
          momentId: header.momentId,
        },
        bytes,
        () => {
          sendPlayback(false)
          input.onPlaying(false)
        },
      ).then(() => {
        sendPlayback(true)
        input.onPlaying(true)
      })
    }

    socket.onerror = () => {
      // `onclose` follows; the state change is reported once, there.
    }

    socket.onclose = () => {
      connected = false
      input.onState('closed')
      if (ws === socket) ws = null
      scheduleReconnect()
    }
  }

  return {
    start() {
      if (stopped) {
        stopped = false
      }
      connect()
      if (flushTimer === null) {
        flushTimer = setInterval(() => {
          void flush()
        }, FLUSH_MS)
      }
    },

    stop() {
      stopped = true
      connected = false
      if (flushTimer !== null) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      stopLine()
      try {
        ws?.close()
      } catch {
        // Already closed.
      }
      ws = null
    },

    respond(action, observationId) {
      outbox.push({
        source: 'phone',
        kind: PHONE_SIGNAL.nudgeResponse,
        ts: new Date().toISOString(),
        confidence: 1,
        payload: { action, observationId },
      })
      void flush()
    },

    get connected() {
      return connected
    },
  }
}
