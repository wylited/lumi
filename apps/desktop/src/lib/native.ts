/**
 * The bridge to the Rust signal modules.
 *
 * Rust emits each `Signal` as `heli://signal`. This keeps the recent ones for Settings, and while
 * a server session is live, ships them every 5 s as a `SignalBatch` (plus any new screen frame).
 * Outside Tauri — the browser preview — there are no native signals, and everything here is a
 * quiet no-op.
 */
import { useSyncExternalStore } from 'react'
import { Signal, type SignalBatch } from '@heli/contracts'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { postScreenFrame, postSignals } from './api'
import { live } from './live'
import { logger } from './log'

const log = logger('native')
const FLUSH_MS = 5000

export interface PermissionState {
  id: 'accessibility' | 'screen' | 'input' | 'focus'
  label: string
  state: 'granted' | 'missing' | 'unavailable'
  usedFor: string
  pane: string | null
}

let recent: Signal[] = []
let pending: Signal[] = []
let frameRef: string | null = null
const listeners = new Set<() => void>()

function push(s: Signal) {
  recent = [s, ...recent].slice(0, 60)
  pending.push(s)
  if (s.kind === 'screen.frame' && typeof s.payload.ref === 'string') frameRef = s.payload.ref
  listeners.forEach((l) => l())
}

async function flush() {
  const snap = live.get()
  if (snap.source !== 'server' || !snap.session || pending.length === 0) {
    // No session to attach them to: keep only the last minute's worth.
    pending = pending.slice(-120)
    return
  }
  const batch: SignalBatch = {
    deviceId: snap.session.deviceId,
    sessionId: snap.session.id,
    signals: pending.splice(0, 500),
  }
  if (!(await postSignals(batch))) pending.unshift(...batch.signals)
  if (frameRef) {
    const ref = frameRef
    frameRef = null
    const jpeg = await invoke<ArrayBuffer>('latest_screen_frame')
    if (jpeg.byteLength) await postScreenFrame(snap.session.id, ref, jpeg)
  }
}

export const native = {
  available: isTauri(),

  /** Start listening. Returns the unhook. */
  attach(): () => void {
    if (!isTauri()) return () => {}
    const unlisten = listen<unknown>('heli://signal', (e) => {
      const parsed = Signal.safeParse(e.payload)
      if (parsed.success) push(parsed.data)
      else log.warn('dropped a malformed native signal', parsed.error.issues)
    })
    const timer = setInterval(() => void flush(), FLUSH_MS)
    return () => {
      clearInterval(timer)
      void unlisten.then((u) => u())
    }
  },

  async permissions(): Promise<PermissionState[]> {
    if (!isTauri()) return []
    return invoke<PermissionState[]>('permissions')
  },
  request: (id: string) =>
    isTauri() ? invoke<boolean>('request_permission', { id }) : Promise.resolve(false),
  openPane: (pane: string) =>
    isTauri() ? invoke('open_settings_pane', { pane }) : Promise.resolve(),
  denylist: () =>
    isTauri() ? invoke<string[]>('screen_denylist') : Promise.resolve([] as string[]),
  setDenylist: (bundleIds: string[]) =>
    isTauri() ? invoke('set_screen_denylist', { bundleIds }) : Promise.resolve(),
}

export function useRecentSignals(): Signal[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => recent,
  )
}
