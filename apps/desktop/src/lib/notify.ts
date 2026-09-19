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
import { live } from './live'
import { logger } from './log'

const log = logger('notify')
const SNOOZE_MS = 10 * 60_000

export interface Nudge {
  id: string
  message: string
  at: number
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
    if (granted) sendNotification({ title: 'Helicopter', body })
  } catch (error) {
    log.warn('native notification failed', error)
  }
}

function handle(i: Intervention, focusMode: boolean) {
  const snoozed = state.snoozedUntil !== null && Date.now() < state.snoozedUntil
  if (i.channel === 'notification' && i.message) {
    if (focusMode || snoozed) {
      decide({
        tier: 2,
        shown: 'tray',
        reason: focusMode ? 'downgraded: Focus is on' : 'downgraded: snoozed',
      })
      return
    }
    set({ nudge: { id: `${Date.now()}`, message: i.message, at: Date.now() } })
    void native(i.message)
    decide({ tier: 2, shown: 'notification', reason: i.reason })
  } else if (i.channel === 'speech' && i.message) {
    if (snoozed) {
      decide({ tier: 3, shown: 'tray', reason: 'downgraded: snoozed' })
      return
    }
    // Escalation supersedes the nudge card: the spoken line is the current ask.
    set({ nudge: null })
    const played = audio.say(i.message)
    decide({ tier: 3, shown: played ? 'speech' : 'tray', reason: played ? i.reason : 'muted' })
  }
}

export const notify = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },

  /** Wire the surfaces to the live store. Returns the unhook. */
  attach(): () => void {
    return live.onEvent((e, snap) => {
      if (e.event === 'intervention') handle(e.data, snap.window?.focusMode ?? false)
    })
  },

  backToGoal() {
    set({ nudge: null })
    log.info('nudge acknowledged: back to the goal')
  },

  snooze() {
    set({ nudge: null, snoozedUntil: Date.now() + SNOOZE_MS })
    log.info('nudges snoozed for 10 min')
  },

  dismiss() {
    set({ nudge: null })
  },
}

export function useNotify(): NotifyState {
  return useSyncExternalStore(notify.subscribe, notify.get)
}
