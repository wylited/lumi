import { useSyncExternalStore } from 'react'
import * as SecureStore from 'expo-secure-store'

/**
 * The pairing the phone holds: the API it talks to, and the token it talks with.
 * The token is the durable half of pairing — the server can forget the phone and
 * the phone still says hello with this.
 *
 * `undefined` means "not read from the keychain yet", which is different from
 * `null` ("read: this phone is not paired"). The root navigator waits for the
 * difference before it decides where to send the person.
 */

export interface Pairing {
  serverUrl: string
  token: string
  phoneId: string
  phoneName: string
}

const KEY = 'heli.pairing.v1'

let cached: Pairing | null | undefined
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getPairing = (): Pairing | null | undefined => cached

export async function loadPairing(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    cached = raw === null ? null : (JSON.parse(raw) as Pairing)
  } catch {
    cached = null
  }
  emit()
}

export async function savePairing(pairing: Pairing): Promise<void> {
  cached = pairing
  await SecureStore.setItemAsync(KEY, JSON.stringify(pairing))
  emit()
}

export async function clearPairing(): Promise<void> {
  cached = null
  await SecureStore.deleteItemAsync(KEY)
  emit()
}

export function usePairing(): { ready: boolean; pairing: Pairing | null } {
  const value = useSyncExternalStore(subscribe, getPairing, getPairing)
  return { ready: value !== undefined, pairing: value ?? null }
}
