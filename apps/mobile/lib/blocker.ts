import { useEffect, useState } from 'react'
import { requireOptionalNativeModule } from 'expo-modules-core'
import * as SecureStore from 'expo-secure-store'
import type { MobileBlocklist } from '@heli/contracts'

/**
 * The Android blocker (`modules/app-blocker`), reached defensively like usage stats: absent in
 * Expo Go and on iOS, where everything here answers "not available".
 *
 * The service does the blocking on its own; `lib/session` keeps its list current from the one poll
 * the screen makes, and this file hands the service's events to the signal sampler.
 */

interface AppBlockerModule {
  isEnabled(): Promise<boolean>
  openSettings(): Promise<void>
  setBlocklist(apps: string[], goal: string | null, active: boolean): Promise<void>
  drainEvents(): Promise<{ action: string; app: string; ts: number }[]>
}

const native = requireOptionalNativeModule<AppBlockerModule>('AppBlocker')

export const blockerAvailable = native !== null

export async function blockerEnabled(): Promise<boolean> {
  if (native === null) return false
  try {
    return await native.isEnabled()
  } catch {
    return false
  }
}

export async function openBlockerSettings(): Promise<void> {
  try {
    await native?.openSettings()
  } catch {
    // Nothing to open; the card already says blocking is not available.
  }
}

/** Hand the service the list it enforces. The service keeps the last one while offline. */
export async function applyBlocklist(list: MobileBlocklist): Promise<void> {
  try {
    await native?.setBlocklist(list.apps, list.goal, list.active)
  } catch {
    // The module refused: the service keeps its previous list.
  }
}

export interface BlockEvent {
  action: 'sent_home' | 'undone'
  app: string
  ts: number
}

/*
 * The phone's own record of what it blocked, newest first, kept for the Blocking tab. The server
 * gets the same events as signals; this copy is what the screen can show without asking.
 */
const LOG_KEY = 'lumi.blocks.log'
const LOG_LIMIT = 30
let log: BlockEvent[] | null = null
const logListeners = new Set<() => void>()

async function readLog(): Promise<BlockEvent[]> {
  if (log) return log
  try {
    const raw = await SecureStore.getItemAsync(LOG_KEY)
    log = raw ? (JSON.parse(raw) as BlockEvent[]) : []
  } catch {
    log = []
  }
  return log
}

async function appendLog(events: BlockEvent[]): Promise<void> {
  if (events.length === 0) return
  const next = [...[...events].reverse(), ...(await readLog())].slice(0, LOG_LIMIT)
  log = next
  logListeners.forEach((l) => l())
  await SecureStore.setItemAsync(LOG_KEY, JSON.stringify(next)).catch(() => undefined)
}

export function useBlockLog(): BlockEvent[] {
  const [events, setEvents] = useState<BlockEvent[]>(log ?? [])
  useEffect(() => {
    void readLog().then(setEvents)
    const l = () => setEvents(log ?? [])
    logListeners.add(l)
    return () => {
      logListeners.delete(l)
    }
  }, [])
  return events
}

/** Blocks and undos since the last call, for the signal batch — and for the phone's own log. */
export async function blockerEvents(): Promise<{ action: string; app: string }[]> {
  if (native === null) return []
  try {
    const drained = await native.drainEvents()
    await appendLog(
      drained
        .filter((e) => e.action === 'sent_home' || e.action === 'undone')
        .map((e) => ({ action: e.action as BlockEvent['action'], app: e.app, ts: e.ts })),
    )
    return drained.map(({ action, app }) => ({ action, app }))
  } catch {
    return []
  }
}
