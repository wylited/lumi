import { randomUUID } from 'node:crypto'

import { MEDIA_TAG } from '@heli/contracts'
import type { AudioOut } from '@heli/contracts'

import type { Transport } from '../observe/types.js'

/**
 * The transport seam. It is deliberately ignorant of sockets, sessions and
 * Prisma: it is handed senders and nothing else, so the same `Transport` works
 * against the device socket, the desktop socket or an in-memory recorder.
 */
export interface TransportSenders {
  /** Send a JSON payload. Returns whether the sender accepted it. */
  sendToSession(sessionId: string, payload: unknown): boolean
  /** Send a tagged binary frame. Returns whether the sender accepted it. */
  sendBinaryToSession(sessionId: string, bytes: Buffer): boolean
  /** Show a notification with an action. Returns whether it was shown. */
  sendNotification(sessionId: string, message: string): boolean
}

/**
 * The loop's senders, narrowed to what the transport requires.
 *
 * `LoopSenders.sendBinaryToSession` is optional — a surface that cannot carry
 * audio is a real thing to build (`observe/outbound.ts` keeps that honest with a
 * `false`) — while the transport needs the member to exist so it can ask. The
 * absent one becomes "no", which is the same answer it would have given.
 */
export function transportSenders(senders: {
  sendToSession(sessionId: string, payload: unknown): boolean
  sendBinaryToSession?(sessionId: string, bytes: Buffer): boolean
  sendNotification(sessionId: string, message: string): boolean
}): TransportSenders {
  return {
    sendToSession: (sessionId, payload) => senders.sendToSession(sessionId, payload),
    sendBinaryToSession: (sessionId, bytes) =>
      senders.sendBinaryToSession ? senders.sendBinaryToSession(sessionId, bytes) : false,
    sendNotification: (sessionId, message) => senders.sendNotification(sessionId, message),
  }
}

const AUDIO_TAG = MEDIA_TAG.audio

function taggedAudio(pcm: Buffer): Buffer {
  return Buffer.concat([Buffer.from([AUDIO_TAG]), pcm])
}

export function createTransport(senders: TransportSenders): Transport {
  return {
    async deliverLine(input) {
      const pcm = input.audio.pcmBase64
        ? Buffer.from(input.audio.pcmBase64, 'base64')
        : Buffer.alloc(0)
      if (pcm.length === 0) {
        return { delivered: false, acknowledged: false }
      }

      const momentId = input.momentId ?? `moment_${randomUUID()}`
      const header = {
        t: 'audio.out',
        format: 'pcm_s16le',
        sampleRate: input.audio.sampleRate,
        channels: input.audio.channels,
        durationMs: input.audio.durationMs,
        momentId,
      } satisfies AudioOut & { t: 'audio.out' }

      // The header must precede the PCM: the device reads it to configure the
      // speaker before the tagged chunk arrives. Order is part of the contract.
      const headerAccepted = senders.sendToSession(input.sessionId, header)
      const audioAccepted = senders.sendBinaryToSession(input.sessionId, taggedAudio(pcm))
      const delivered = headerAccepted && audioAccepted

      return { delivered, acknowledged: delivered }
    },

    async nudge(input) {
      return senders.sendNotification(input.sessionId, input.message)
    },
  }
}

export type TransportRecord =
  | { kind: 'audio.out'; sessionId: string; header: AudioOut & { t: 'audio.out' } }
  | { kind: 'audio.pcm'; sessionId: string; tag: number; bytes: Buffer }
  | { kind: 'notification'; sessionId: string; message: string }

export interface InMemoryTransport extends Transport {
  readonly records: TransportRecord[]
  reset(): void
}

/**
 * A recorder for tests and keyless local runs. It keeps every message in the
 * order it was handed over, which is how the `audio.out`-then-PCM contract is
 * proven without a socket.
 */
export function inMemoryTransport(): InMemoryTransport {
  const records: TransportRecord[] = []

  const senders: TransportSenders = {
    sendToSession(sessionId, payload) {
      records.push({
        kind: 'audio.out',
        sessionId,
        header: payload as AudioOut & { t: 'audio.out' },
      })
      return true
    },
    sendBinaryToSession(sessionId, bytes) {
      records.push({
        kind: 'audio.pcm',
        sessionId,
        tag: bytes[0] ?? AUDIO_TAG,
        bytes,
      })
      return true
    },
    sendNotification(sessionId, message) {
      records.push({ kind: 'notification', sessionId, message })
      return true
    },
  }

  return {
    ...createTransport(senders),
    records,
    reset() {
      records.length = 0
    },
  }
}
