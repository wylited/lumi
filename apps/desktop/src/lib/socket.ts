/**
 * `/ws/desktop` — how the server reaches the person at the Mac.
 *
 * The server sends a tier-2 `nudge` and a tier-3 `audio.out` header followed by one binary frame
 * (`MEDIA_TAG.audio`, then PCM S16LE). The desktop shows the nudge, plays the audio, and reports its
 * own playback — the only thing besides signals it may write. Stopping early is barge-in.
 *
 * With a server, this socket is the one source of nudges and voice; the SSE `intervention` events
 * only feed the timeline, so nothing fires twice.
 */
import {
  ApiToDesktop,
  MEDIA_TAG,
  HELI_SOCKET_PROTOCOL,
  type ApiAudioOut,
  type DesktopToApi,
} from '@heli/contracts'
import { socketTarget } from './api'
import { audio } from './audio'
import { logger } from './log'

const log = logger('socket')
const APP_VERSION = '0.1.0'
const BACKOFF_MS = [1000, 2000, 5000, 10_000]

export interface NudgeMessage {
  message: string
  observationId: string | null
}

type Listener = (n: NudgeMessage) => void

let ws: WebSocket | null = null
let wanted: { sessionId: string; deviceId: string } | null = null
let attempt = 0
let retry: ReturnType<typeof setTimeout> | null = null
let pendingAudio: ApiAudioOut | null = null
let playingMoment: string | null = null
const nudgeListeners = new Set<Listener>()
export interface AutomationRequest {
  action: string
  target: string | null
  message: string
}
const automationListeners = new Set<(a: AutomationRequest) => void>()
let lineText: () => string | null = () => null

function send(message: DesktopToApi) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function onText(text: string) {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    log.warn('dropped a frame that is not JSON')
    return
  }
  const parsed = ApiToDesktop.safeParse(json)
  if (!parsed.success) {
    log.warn('dropped a message outside the contract', parsed.error.issues[0]?.message)
    return
  }
  const m = parsed.data
  switch (m.t) {
    case 'nudge':
      nudgeListeners.forEach((l) => l({ message: m.message, observationId: m.observationId }))
      break
    case 'automation':
      automationListeners.forEach((l) => l({ action: m.action, target: m.target, message: m.message }))
      break
    case 'audio.out':
      // The PCM follows as the next binary frame; order is part of the contract.
      pendingAudio = m
      break
    case 'error':
      log.warn(`server: ${m.code}`, m.message)
      break
    case 'ack':
      break
  }
}

function onBinary(data: ArrayBuffer) {
  const bytes = new Uint8Array(data)
  if (bytes[0] !== MEDIA_TAG.audio || !pendingAudio) {
    log.debug('binary frame with no audio header before it; dropped')
    return
  }
  const header = pendingAudio
  pendingAudio = null
  playingMoment = header.momentId
  // The words arrive over SSE; the samples arrive here. Show the words if we have them.
  audio.say(lineText() ?? 'Lumi is speaking', {
    bytes: bytes.subarray(1),
    sampleRate: header.sampleRate,
    channels: header.channels,
  })
}

function open() {
  void (async () => {
    const target = await socketTarget()
    if (!target || !wanted) return
    const socket = new WebSocket(target.url, [HELI_SOCKET_PROTOCOL, target.token])
    socket.binaryType = 'arraybuffer'
    ws = socket
    socket.onopen = () => {
      attempt = 0
      send({
        t: 'hello',
        appVersion: APP_VERSION,
        deviceId: wanted?.deviceId ?? null,
        sessionId: wanted?.sessionId ?? null,
      })
      log.info('desktop socket open')
    }
    socket.onmessage = (e) => {
      if (typeof e.data === 'string') onText(e.data)
      else if (e.data instanceof ArrayBuffer) onBinary(e.data)
    }
    socket.onclose = () => {
      if (ws === socket) ws = null
      if (!wanted) return
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
      attempt += 1
      log.debug(`desktop socket closed; retrying in ${wait} ms`)
      retry = setTimeout(open, wait)
    }
  })()
}

// Report our own playback, keyed to the moment the server named.
audio.onPlayback((playing) => {
  if (!playingMoment) return
  send({ t: 'playback', playing, momentId: playingMoment })
  if (!playing) playingMoment = null
})

export const desktopSocket = {
  /** Keep a socket open for this session until `close()`. Reconnects with backoff. */
  connect(sessionId: string, deviceId: string) {
    wanted = { sessionId, deviceId }
    if (!ws) open()
  },
  close() {
    wanted = null
    if (retry) clearTimeout(retry)
    retry = null
    ws?.close()
    ws = null
  },
  isOpen: () => ws?.readyState === WebSocket.OPEN,
  /** Where the speech bar gets the words for the audio it is playing. */
  setLineProvider(fn: () => string | null) {
    lineText = fn
  },
  onNudge(l: Listener) {
    nudgeListeners.add(l)
    return () => nudgeListeners.delete(l)
  },
  /** Tier 4 from the loop. `lib/block` carries it out. */
  onAutomation(l: (a: AutomationRequest) => void) {
    automationListeners.add(l)
    return () => automationListeners.delete(l)
  },
}
