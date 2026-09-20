/** The live session, as one store, fed by the server's SSE channel. */
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
import { api, subscribe } from './api'
import { logger } from './log'
import { desktopSocket } from './socket'
import type { TrayState } from './tray'

const log = logger('live')

export interface LiveSnapshot {
  status: 'idle' | 'connecting' | 'live'
  session: Session | null
  goal: Goal | null
  observations: Observation[]
  window: SignalWindow | null
  deviceState: DeviceState | null
}

const EMPTY: LiveSnapshot = {
  status: 'idle',
  session: null,
  goal: null,
  observations: [],
  window: null,
  deviceState: null,
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
    desktopSocket.connect(open.id, open.deviceId)
    stop = () => {
      unsub()
      desktopSocket.close()
    }
    const goal = goals.find((g) => g.id === open.goalId) ?? null
    set({ ...EMPTY, status: 'live', session: open, goal })
    log.info(`attached to ${open.id}`)
    return true
  },

  /**
   * Open a session for the goal and watch it. The server resolves the machine; frames from the rig
   * are refused until a session is open, so this is what makes the desk count. Throws if it did not open.
   */
  async start(goalId: string): Promise<void> {
    const open = (await api.sessions()).find((s) => s.endedAt === null)
    if (!open && !(await api.openSessionFor(goalId))) throw new Error('The session did not open.')
    if (!(await live.attach())) throw new Error('The session opened, but its live channel did not.')
  },

  /** Close the open session on the server, then stop watching it. */
  async finish(): Promise<void> {
    const id = snap.session?.id
    if (id) await api.closeSession(id)
    live.end()
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
  /** The window rows alone: a survey row is an observation, and it is not a minute. */
  windows: Observation[]
  /** The newest desk reading, which came on a row of its own and not on a window. */
  latestSurvey: Observation | null
  latest: Observation | null
  /** The run of silent windows at the end, in windows. */
  quietFor: number
  tray: TrayState
}

export function derive(s: LiveSnapshot): Derived {
  // A survey row carries the reading and the window it was taken on, so it would double-count
  // every fold below: the minutes, the sums, the quiet run and the tray all read windows only.
  const windows = s.observations.filter((o) => o.survey === null)
  let focused = 0
  let off = 0
  let switches = 0
  let run = 0
  let longest = 0
  for (const o of windows) {
    focused += o.signals.focusedSeconds
    off += o.signals.offTaskSeconds
    switches += o.signals.contextSwitches
    if (o.assessment?.onTask && o.assessment.activity !== 'break') {
      run += o.signals.focusedSeconds
      longest = Math.max(longest, run)
    } else run = 0
  }
  let quiet = 0
  for (let i = windows.length - 1; i >= 0 && windows[i]!.tier === 0; i -= 1) quiet += 1
  let latestSurvey: Observation | null = null
  for (let i = s.observations.length - 1; i >= 0; i -= 1) {
    const o = s.observations[i]!
    if (o.survey !== null) {
      latestSurvey = o
      break
    }
  }
  const latest = windows[windows.length - 1] ?? null
  const tray: TrayState =
    s.status !== 'live'
      ? 'idle'
      : s.deviceState === 'speaking'
        ? 'speaking'
        : latest && latest.assessment && !latest.assessment.onTask
          ? 'off_task'
          : 'watching'
  return {
    minutes: windows.length,
    focusedMinutes: focused / 60,
    offTaskMinutes: off / 60,
    switches,
    longestRunSeconds: longest,
    currentRunSeconds: run,
    ratios: windows.map((o) => o.signals.onTaskRatio),
    windows,
    latestSurvey,
    latest,
    quietFor: quiet,
    tray,
  }
}

/** An intervention's outcome is only known once a later window exists; before that, it is pending. */
export function settledOutcome(s: LiveSnapshot, o: Observation): Observation['outcome'] {
  const i = s.observations.indexOf(o)
  if (i < 0) return null
  // Only a window can judge the intervention, so a survey row after it leaves it pending.
  return s.observations.some((later, j) => j > i && later.survey === null) ? o.outcome : null
}

export type { Intervention }
