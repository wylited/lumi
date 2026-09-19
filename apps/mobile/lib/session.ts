import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'

import { MobileSession } from '@heli/contracts'

import { normalizeBase } from './api'
import { applyBlocklist } from './blocker'

/**
 * The phone's one screen, from `GET /v1/mobile/session`: polled every few seconds while the app
 * is in front. The same answer keeps the blocker's list current, so there is one poll, not two.
 *
 * The server's phone numbers are running totals (unlocks and seconds per app since it first heard
 * this phone). The share of *this session* is those totals minus the ones seen when the session
 * began, kept per session so reopening the app does not reset them.
 */

const POLL_MS = 5_000
const BASELINE_KEY = 'lumi.session.baseline'

interface Baseline {
  sessionId: string
  unlocks: number
  apps: Record<string, number>
}

export interface SessionView {
  data: MobileSession
  /** This session on this phone; null on iOS or before the first signal. */
  phone: {
    unlocks: number
    seconds: number
    apps: { app: string; seconds: number }[]
  } | null
}

async function loadBaseline(): Promise<Baseline | null> {
  try {
    const raw = await SecureStore.getItemAsync(BASELINE_KEY)
    return raw ? (JSON.parse(raw) as Baseline) : null
  } catch {
    return null
  }
}

async function share(data: MobileSession): Promise<SessionView['phone']> {
  const phone = data.phone
  const session = data.session
  if (!phone || !session || phone.platform !== 'android') return null
  let base = await loadBaseline()
  if (!base || base.sessionId !== session.id || phone.unlocks < base.unlocks) {
    base = {
      sessionId: session.id,
      unlocks: phone.unlocks,
      apps: Object.fromEntries(phone.topApps.map((a) => [a.app, a.seconds])),
    }
    await SecureStore.setItemAsync(BASELINE_KEY, JSON.stringify(base)).catch(() => undefined)
  }
  const b = base
  const apps = phone.topApps
    .map((a) => ({ app: a.app, seconds: Math.max(0, a.seconds - (b.apps[a.app] ?? 0)) }))
    // Time spent looking at Lumi itself is not time lost to the phone.
    .filter((a) => a.seconds >= 1 && a.app !== 'Lumi')
    .sort((x, y) => y.seconds - x.seconds)
  return {
    unlocks: Math.max(0, phone.unlocks - b.unlocks),
    seconds: apps.reduce((n, a) => n + a.seconds, 0),
    apps,
  }
}

/** `undefined` until the first answer; `null` when the server cannot be reached. */
export function useSession(serverUrl: string, token: string): SessionView | null | undefined {
  const [view, setView] = useState<SessionView | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const response = await fetch(`${normalizeBase(serverUrl)}/v1/mobile/session`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = MobileSession.parse(await response.json())
        void applyBlocklist(data.blocklist)
        const phone = await share(data)
        if (alive) setView({ data, phone })
      } catch {
        // Offline: keep showing the last answer; the header says the socket is down.
        if (alive) setView((v) => (v === undefined ? null : v))
      }
    }
    void poll()
    const t = setInterval(() => {
      if (AppState.currentState === 'active') void poll()
    }, POLL_MS)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void poll()
    })
    return () => {
      alive = false
      clearInterval(t)
      sub.remove()
    }
  }, [serverUrl, token])

  return view
}
