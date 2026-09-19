import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import * as Haptics from 'expo-haptics'
import * as Notifications from 'expo-notifications'

import { blockerAvailable, blockerEnabled } from './blocker'
import { useSession, type SessionView } from './session'
import { createSignalSampler, type SignalSampler } from './signals'
import { createPhoneSocket, type Nudge, type PhoneSocket } from './socket'
import type { Pairing } from './store'
import { hasUsagePermission, usageStatsAvailable } from './usage'

/**
 * One live connection for the whole app: the socket (nudges, speech), the signal sampler, the
 * session poll and the grants. The tabs read it; nothing below opens its own.
 */

export interface Grants {
  usage: boolean
  blocking: boolean
  notifications: boolean
}

interface Live {
  pairing: Pairing
  connection: 'connecting' | 'open' | 'closed'
  view: SessionView | null | undefined
  nudge: Nudge | null
  playing: boolean
  notice: string | null
  grants: Grants
  android: boolean
  checkGrants: () => Promise<void>
  answer: (action: 'back_to_goal' | 'snooze_10m') => void
}

const LiveContext = createContext<Live | null>(null)

export function useLive(): Live {
  const live = useContext(LiveContext)
  if (!live) throw new Error('useLive outside LiveProvider')
  return live
}

export function LiveProvider({ pairing, children }: { pairing: Pairing; children: ReactNode }) {
  const [connection, setConnection] = useState<Live['connection']>('connecting')
  const [nudge, setNudge] = useState<Nudge | null>(null)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [grants, setGrants] = useState<Grants>({ usage: true, blocking: true, notifications: true })
  const live = useRef<{ sampler: SignalSampler; socket: PhoneSocket } | null>(null)
  const view = useSession(pairing.serverUrl, pairing.token)

  const checkGrants = useCallback(async () => {
    const [usage, blocking, notifications] = await Promise.all([
      usageStatsAvailable ? hasUsagePermission() : Promise.resolve(true),
      blockerAvailable ? blockerEnabled() : Promise.resolve(true),
      Notifications.getPermissionsAsync()
        .then((p) => p.granted)
        .catch(() => true),
    ])
    setGrants({ usage, blocking, notifications })
  }, [])

  useEffect(() => {
    const sampler = createSignalSampler()
    sampler.start()
    const socket = createPhoneSocket({
      serverUrl: pairing.serverUrl,
      token: pairing.token,
      phoneName: pairing.phoneName,
      sampler,
      onState: setConnection,
      onNudge: (n) => {
        setNudge(n)
        if (n) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined)
      },
      onPlaying: setPlaying,
      onNotice: setNotice,
    })
    socket.start()
    live.current = { sampler, socket }
    void checkGrants()
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void checkGrants()
    })
    return () => {
      sub.remove()
      socket.stop()
      sampler.stop()
      live.current = null
    }
  }, [pairing.serverUrl, pairing.token, pairing.phoneName, checkGrants])

  const answer = useCallback(
    (action: 'back_to_goal' | 'snooze_10m') => {
      if (nudge) live.current?.socket.respond(action, nudge.observationId)
      setNudge(null)
    },
    [nudge],
  )

  const value = useMemo<Live>(
    () => ({
      pairing,
      connection,
      view,
      nudge,
      playing,
      notice,
      grants,
      android: Platform.OS === 'android',
      checkGrants,
      answer,
    }),
    [pairing, connection, view, nudge, playing, notice, grants, checkGrants, answer],
  )

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
