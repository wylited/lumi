/**
 * The live session, as one store. Fed by the server's SSE channel when there is one and by the
 * fixture feed when there is not — the events are the same `LiveEvent`s either way, so nothing
 * downstream can tell.
 */
import { useSyncExternalStore } from 'react'
import type {
  DeviceState,
  Goal,
  Intervention,
  LiveEvent,
  Observation,
  Session,
  SignalWindow,
} from '@heli/contracts'
import { createLiveFeed, type LiveScenario } from '@heli/fixtures'
import { api, demo, subscribe } from './api'
import { logger } from './log'
import type { TrayState } from './tray'

const log = logger('live')

export interface LiveSnapshot {
  status: 'idle' | 'connecting' | 'live'
  source: 'server' | 'demo' | null
  session: Session | null
  goal: Goal | null
  observations: Observation[]
  window: SignalWindow | null
  deviceState: DeviceState | null
  /** Wall-clock ms one window stands for. Real time is 60 000; the demo runs faster. */
  msPerWindow: number
}

const EMPTY: LiveSnapshot = {
  status: 'idle',
  source: null,
  session: null,
  goal: null,
  observations: [],
  window: null,
  deviceState: null,
  msPerWindow: 60_000,
}

let snap: LiveSnapshot = EMPTY
let stop: (() => void) | null = null
const listeners = new Set<() => void>()
const eventListeners = new Set<(e: LiveEvent, s: LiveSnapshot) => void>()

function set(next: Partial<LiveSnapshot>) {
  snap = { ...snap, ...next }
  listeners.forEach((l) => l())
}

function ingest(event: LiveEvent) {
  switch (event.event) {
    case 'observation':
      set({ observations: [...snap.observations, event.data].slice(-240) })
      break
    case 'signal.window':
      set({ window: event.data })
      break
    case 'state':
      set({ deviceState: event.data.deviceState })
      break
    case 'intervention':
      break
  }
  eventListeners.forEach((l) => l(event, snap))
}

export const live = {
  get: () => snap,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  /** Every event, after it has been folded into the snapshot. Notifications and audio hang here. */
  onEvent(l: (e: LiveEvent, s: LiveSnapshot) => void) {
    eventListeners.add(l)
    return () => eventListeners.delete(l)
  },

  /** Attach to the session the desk has open, if the server has one. */
  async attach(): Promise<boolean> {
    set({ status: 'connecting' })
    const [sessions, goals] = await Promise.all([api.sessions(), api.goals()])
    const open = sessions.find((s) => s.endedAt === null)
    if (!open) {
      set({ status: 'idle' })
      return false
    }
    const unsub = await subscribe(open.id, ingest)
    if (!unsub) {
      set({ status: 'idle' })
      return false
    }
    stop?.()
    stop = unsub
    const goal = goals.find((g) => g.id === open.goalId) ?? null
    set({ ...EMPTY, status: 'live', source: 'server', session: open, goal })
    log.info(`attached to ${open.id}`)
    return true
  },

  /** A local run on fixture data, at `tickMs` per window, for demos and development. */
  startDemo(scenario: LiveScenario = 'drifting', tickMs = 4000) {
    stop?.()
    const goal = demo().world.goal
    set({ ...EMPTY, status: 'live', source: 'demo', goal, msPerWindow: tickMs })
    const feed = createLiveFeed({ goal, scenario, tickMs, onEvent: ingest })
    set({ session: feed.session })
    stop = feed.stop
  },

  end() {
    stop?.()
    stop = null
    set(EMPTY)
  },
}

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(live.subscribe, live.get)
}

/* ---- derived ------------------------------------------------------------ */

export interface Derived {
  minutes: number
  focusedMinutes: number
  offTaskMinutes: number
  switches: number
  longestRunSeconds: number
  currentRunSeconds: number
  ratios: number[]
  latest: Observation | null
  /** The run of silent windows at the end, in windows. */
  quietFor: number
  tray: TrayState
}

export function derive(s: LiveSnapshot): Derived {
  let focused = 0
  let off = 0
  let switches = 0
  let run = 0
  let longest = 0
  for (const o of s.observations) {
    focused += o.signals.focusedSeconds
    off += o.signals.offTaskSeconds
    switches += o.signals.contextSwitches
    if (o.assessment?.onTask && o.assessment.activity !== 'break') {
      run += o.signals.focusedSeconds
      longest = Math.max(longest, run)
    } else run = 0
  }
  let quiet = 0
  for (let i = s.observations.length - 1; i >= 0 && s.observations[i]!.tier === 0; i -= 1)
    quiet += 1
  const latest = s.observations[s.observations.length - 1] ?? null
  const tray: TrayState =
    s.status !== 'live'
      ? 'idle'
      : s.deviceState === 'speaking'
        ? 'speaking'
        : latest && latest.assessment && !latest.assessment.onTask
          ? 'off_task'
          : 'watching'
  return {
    minutes: s.observations.length,
    focusedMinutes: focused / 60,
    offTaskMinutes: off / 60,
    switches,
    longestRunSeconds: longest,
    currentRunSeconds: run,
    ratios: s.observations.map((o) => o.signals.onTaskRatio),
    latest,
    quietFor: quiet,
    tray,
  }
}

/** An intervention's outcome is only known once a later window exists; before that, it is pending. */
export function settledOutcome(s: LiveSnapshot, o: Observation): Observation['outcome'] {
  const i = s.observations.indexOf(o)
  return i >= 0 && i < s.observations.length - 1 ? o.outcome : null
}

export type { Intervention }
