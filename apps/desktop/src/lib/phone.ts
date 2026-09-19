/**
 * The paired phone, watched from Live. `GET /v1/mobile/phones` answers running totals (unlocks and
 * seconds per app since the server first heard the phone), so this store remembers the totals it
 * saw when the session began and reports the difference: what happened on the phone *this session*.
 *
 * The baseline is kept per session in localStorage, so reopening the app mid-session does not
 * reset the counts. A server restart zeroes its totals; a total below its baseline re-bases.
 */
import { useEffect, useState } from 'react'
import type { PhoneSnapshot } from '@heli/contracts'
import { api } from './api'

const POLL_MS = 5000
const KEY = 'lumi.phone.baseline'

interface Baseline {
  sessionId: string
  phoneId: string
  unlocks: number
  apps: Record<string, number>
}

export interface PhoneSession {
  phone: PhoneSnapshot
  unlocks: number
  /** Seconds per app this session, most first. */
  apps: Array<{ app: string; seconds: number }>
  seconds: number
}

function load(): Baseline | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Baseline) : null
  } catch {
    return null
  }
}

function save(b: Baseline) {
  try {
    localStorage.setItem(KEY, JSON.stringify(b))
  } catch {
    // counts restart from here on the next launch; nothing else depends on it
  }
}

function baselineOf(sessionId: string, phone: PhoneSnapshot): Baseline {
  return {
    sessionId,
    phoneId: phone.phoneId,
    unlocks: phone.unlocks,
    apps: Object.fromEntries(phone.topApps.map((a) => [a.app, a.seconds])),
  }
}

function since(phone: PhoneSnapshot, base: Baseline): PhoneSession {
  const apps = phone.topApps
    .map((a) => ({ app: a.app, seconds: Math.max(0, a.seconds - (base.apps[a.app] ?? 0)) }))
    .filter((a) => a.seconds >= 1)
    .sort((a, b) => b.seconds - a.seconds)
  return {
    phone,
    unlocks: Math.max(0, phone.unlocks - base.unlocks),
    apps,
    seconds: apps.reduce((n, a) => n + a.seconds, 0),
  }
}

/**
 * The most recently seen phone and its share of this session, polled while mounted.
 * `undefined` while the first answer is out; `null` when no phone is paired.
 */
export function usePhoneSession(sessionId: string | null): PhoneSession | null | undefined {
  const [state, setState] = useState<PhoneSession | null | undefined>(undefined)

  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const tick = async () => {
      const phone = (await api.phones())[0] ?? null
      if (!alive) return
      if (!phone) return setState(null)
      let base = load()
      const reset =
        !base ||
        base.sessionId !== sessionId ||
        base.phoneId !== phone.phoneId ||
        phone.unlocks < base.unlocks
      if (reset) {
        base = baselineOf(sessionId, phone)
        save(base)
      }
      setState(since(phone, base as Baseline))
    }
    void tick()
    const t = setInterval(() => void tick(), POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [sessionId])

  return state
}
