import { requireOptionalNativeModule } from 'expo-modules-core'
import { MobileBlocklist } from '@heli/contracts'

import { normalizeBase } from './api'

/**
 * The Android blocker (`modules/app-blocker`), reached defensively like usage stats: absent in
 * Expo Go and on iOS, where everything here answers "not available".
 *
 * The service does the blocking on its own; this file keeps its list current from
 * `GET /v1/mobile/blocklist` and hands its events to the signal sampler.
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

/** Fetch the blocklist and hand it to the service. Returns it, or null when it could not. */
export async function syncBlocklist(serverUrl: string, token: string): Promise<MobileBlocklist | null> {
  if (native === null) return null
  try {
    const response = await fetch(`${normalizeBase(serverUrl)}/v1/mobile/blocklist`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    const list = MobileBlocklist.parse(await response.json())
    await native.setBlocklist(list.apps, list.goal, list.active)
    return list
  } catch {
    // Offline: the service keeps the last list it was given, which is the safe thing to keep.
    return null
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
