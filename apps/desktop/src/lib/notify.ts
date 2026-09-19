/**
 * The interruption surfaces, driven by the live store's interventions.
 *
 * - Tier 2 (a nudge): a native notification, and the in-app card that carries the two actions —
 *   "Back to the goal" and "Snooze 10m". macOS notifications from Tauri cannot hold buttons, so
 *   the card is where the choice is made; the banner brings you to it.
 * - Tier 3 (speech): the line goes to `audio`.
 * - Focus / Do Not Disturb, or a snooze: a nudge is downgraded to tier 1 — the tray goes amber,
 *   nothing pops — and the downgrade is logged with its reason.
 */
import { useSyncExternalStore } from 'react'
import type { Intervention } from '@heli/contracts'
import { isTauri } from '@tauri-apps/api/core'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { audio } from './audio'
import { postSignals } from './api'
import { desktopSocket } from './socket'
import { live } from './live'
import { logger } from './log'

const log = logger('notify')
const SNOOZE_MS = 10 * 60_000

export interface Nudge {
  id: string
  message: string
  at: number
  /** The observation it is about, when the server sent it — how its outcome gets attributed. */
  observationId: string | null
}

export interface Decision {
  at: number
  tier: number
  shown: 'notification' | 'speech' | 'tray'
  reason: string
}

interface NotifyState {
  nudge: Nudge | null
  snoozedUntil: number | null
  decisions: Decision[]
}

let state: NotifyState = { nudge: null, snoozedUntil: null, decisions: [] }
const listeners = new Set<() => void>()
function set(next: Partial<NotifyState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
function decide(d: Omit<Decision, 'at'>) {
  const decision = { ...d, at: Date.now() }
  log.info(`tier ${d.tier} → ${d.shown}: ${d.reason}`)
  set({ decisions: [decision, ...state.decisions].slice(0, 50) })
}

async function native(body: string) {
  if (!isTauri()) return
  try {
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (granted) sendNotification({ title: 'Lumi', body })
  } catch (error) {
    log.warn('native notification failed', error)
  }
}

/** The last spoken line's words, for the speech bar while the server's audio plays. */
let lastLine: string | null = null

function showNudge(
  message: string,
  observationId: string | null,
  reason: string,
  focusMode: boolean,
) {
  const snoozed = state.snoozedUntil !== null && Date.now() < state.snoozedUntil
  if (focusMode || snoozed) {
    decide({
      tier: 2,
      shown: 'tray',
      reason: focusMode ? 'downgraded: Focus is on' : 'downgraded: snoozed',
    })
    return
  }
  set({ nudge: { id: `${Date.now()}`, message, at: Date.now(), observationId } })
  void native(message)
  decide({ tier: 2, shown: 'notification', reason })
}

/**
 * An intervention from the live stream. With a server, the desktop socket is what nudges and speaks
 * (see `lib/socket`), so here it only remembers the words; in the demo it is the whole path.
 */
function handle(i: Intervention, focusMode: boolean, fromServer: boolean) {
  if (i.channel === 'speech' && i.message) lastLine = i.message
  if (fromServer) return
  if (i.channel === 'notification' && i.message) {
    showNudge(i.message, null, i.reason, focusMode)
  } else if (i.channel === 'speech' && i.message) {
    if (state.snoozedUntil !== null && Date.now() < state.snoozedUntil) {
      decide({ tier: 3, shown: 'tray', reason: 'downgraded: snoozed' })
      return
    }
    // Escalation supersedes the nudge card: the spoken line is the current ask.
    set({ nudge: null })
    const played = audio.say(i.message)
    decide({ tier: 3, shown: played ? 'speech' : 'tray', reason: played ? i.reason : 'muted' })
  }
}

/** What the person did with a nudge, back to the server as a signal so the policy can judge it. */
function respond(action: 'back_to_goal' | 'snooze_10m' | 'dismissed') {
  const nudge = state.nudge
  const snap = live.get()
  if (!nudge || snap.source !== 'server' || !snap.session) return
  void postSignals({
    deviceId: snap.session.deviceId,
    sessionId: snap.session.id,
    signals: [
      {
        source: 'system',
        kind: 'nudge.response',
        ts: new Date().toISOString(),
        confidence: 1,
        payload: { action, observationId: nudge.observationId },
      },
    ],
  })
}

export const notify = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },

  /** Wire the surfaces to the live store. Returns the unhook. */
  attach(): () => void {
    const stopLive = live.onEvent((e, snap) => {
      if (e.event === 'intervention')
        handle(e.data, snap.window?.focusMode ?? false, snap.source === 'server')
    })
    const stopNudges = desktopSocket.onNudge((n) => {
      set({ nudge: null })
      showNudge(n.message, n.observationId, 'server nudge', live.get().window?.focusMode ?? false)
    })
    desktopSocket.setLineProvider(() => lastLine)
    return () => {
      stopLive()
      stopNudges()
    }
  },

  backToGoal() {
    respond('back_to_goal')
    set({ nudge: null })
    log.info('nudge acknowledged: back to the goal')
  },

  snooze() {
    respond('snooze_10m')
    set({ nudge: null, snoozedUntil: Date.now() + SNOOZE_MS })
    log.info('nudges snoozed for 10 min')
  },

  dismiss() {
    respond('dismissed')
    set({ nudge: null })
  },
}

export function useNotify(): NotifyState {
  return useSyncExternalStore(notify.subscribe, notify.get)
}
