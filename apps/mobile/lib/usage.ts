import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * The Android usage-stats module (`modules/usage-stats`), reached defensively:
 * in Expo Go the native module is absent, and everything here answers "not
 * available" instead of crashing. The screen says so, which is honest — an
 * iPhone could not answer either.
 */

export interface UsageDelta {
  apps: { app: string; seconds: number }[]
  unlocks: number
  foregroundApp: string | null
}

interface UsageStatsModule {
  hasPermission(): Promise<boolean>
  openSettings(): Promise<void>
  sinceLast(): Promise<UsageDelta>
}

const native = requireOptionalNativeModule<UsageStatsModule>('UsageStats')

export const usageStatsAvailable = native !== null

export async function hasUsagePermission(): Promise<boolean> {
  if (native === null) return false
  try {
    return await native.hasPermission()
  } catch {
    return false
  }
}

export async function openUsageSettings(): Promise<void> {
  if (native === null) return
  try {
    await native.openSettings()
  } catch {
    // Nothing to open; the screen already says usage access is not available.
  }
}

export async function usageSinceLast(): Promise<UsageDelta | null> {
  if (native === null) return null
  try {
    const delta = await native.sinceLast()
    return {
      apps: delta.apps ?? [],
      unlocks: delta.unlocks ?? 0,
      foregroundApp: delta.foregroundApp ?? null,
    }
  } catch {
    return null
  }
}
