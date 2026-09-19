import { requireOptionalNativeModule } from 'expo-modules-core'
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

/** Blocks and undos since the last call, for the signal batch. */
export async function blockerEvents(): Promise<{ action: string; app: string }[]> {
  if (native === null) return []
  try {
    return (await native.drainEvents()).map(({ action, app }) => ({ action, app }))
  } catch {
    return []
  }
}
