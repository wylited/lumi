import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform, ScrollView, View } from 'react-native'
import { Redirect, router } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { space } from '@heli/tokens'

import {
  Blocking,
  Footer,
  Header,
  Moment,
  PhoneToday,
  SessionHero,
  Setup,
  type SetupItem,
} from '@/components/screen'
import { Screen } from '@/components/ui'
import { blockerAvailable, blockerEnabled, openBlockerSettings } from '@/lib/blocker'
import { useSession } from '@/lib/session'
import { createSignalSampler, type SignalSampler } from '@/lib/signals'
import { createPhoneSocket, type Nudge, type PhoneSocket } from '@/lib/socket'
import { clearPairing, usePairing } from '@/lib/store'
import { hasUsagePermission, openUsageSettings, usageStatsAvailable } from '@/lib/usage'

/**
 * The phone's one screen, built around the session: the goal and the clock first, the moment
 * Lumi speaks or nudges when it happens, then what this session looked like on the phone, what is
 * blocked, and — only while something is missing — the setup that is left.
 *
 * The phone is a surface, not a dashboard: it is opened to answer Lumi or to glance at the
 * session, and put away again.
 */
export default function PhoneScreen() {
  const { ready, pairing } = usePairing()
  const insets = useSafeAreaInsets()

  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [nudge, setNudge] = useState<Nudge | null>(null)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [grants, setGrants] = useState({ usage: true, blocking: true, notifications: true })

  const live = useRef<{ sampler: SignalSampler; socket: PhoneSocket } | null>(null)
  const view = useSession(pairing?.serverUrl ?? '', pairing?.token ?? '')

  const checkGrants = useCallback(async () => {
    const [usage, blocking, notifications] = await Promise.all([
      usageStatsAvailable ? hasUsagePermission() : Promise.resolve(true),
      blockerAvailable ? blockerEnabled() : Promise.resolve(true),
      Notifications.getPermissionsAsync().then((p) => p.granted).catch(() => true),
    ])
    setGrants({ usage, blocking, notifications })
  }, [])

  useEffect(() => {
    if (!pairing) return

    const sampler = createSignalSampler()
    sampler.start()
    const socket = createPhoneSocket({
      serverUrl: pairing.serverUrl,
      token: pairing.token,
      phoneName: pairing.phoneName,
      sampler,
      onState: setConnection,
      onNudge: setNudge,
      onPlaying: setPlaying,
      onNotice: setNotice,
    })
    socket.start()
    live.current = { sampler, socket }

    void checkGrants()
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') void checkGrants()
    })

    return () => {
      appState.remove()
      socket.stop()
      sampler.stop()
      live.current = null
    }
  }, [pairing?.serverUrl, pairing?.token, pairing?.phoneName, checkGrants])

  if (!ready) return null
  if (pairing === null) return <Redirect href="/pair" />

  const android = Platform.OS === 'android'
  const setup: SetupItem[] = [
    ...(!grants.notifications
      ? [
          {
            key: 'notifications',
            title: 'Notifications',
            detail: 'So a nudge and a block can reach you with the app closed.',
            action: 'Allow',
            onPress: () => void Notifications.requestPermissionsAsync().then(checkGrants),
          },
        ]
      : []),
    ...(android && !grants.usage
      ? [
          {
            key: 'usage',
            title: 'Usage access',
            detail: 'App time and unlocks. Never what is in an app.',
            action: 'Open',
            onPress: () => void openUsageSettings(),
          },
        ]
      : []),
    ...(android && !grants.blocking
      ? [
          {
            key: 'blocking',
            title: 'Lumi blocking',
            detail: 'In Accessibility. Sends you home from apps your goal blocks.',
            action: 'Open',
            onPress: () => void openBlockerSettings(),
          },
        ]
      : []),
  ]

  const inSession = !!view?.data.session
  const host = pairing.serverUrl.replace(/^https?:\/\//, '')

  return (
    <Screen style={{ paddingTop: insets.top + space[2], paddingBottom: 0 }}>
      <ScrollView
        contentContainerStyle={{ gap: space[8], paddingTop: space[2], paddingBottom: insets.bottom + space[8] }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: space[5] }}>
          <Header connection={connection} />
          <SessionHero view={view} />
        </View>

        <Moment
          playing={playing}
          nudge={nudge}
          onBack={() => {
            if (nudge) live.current?.socket.respond('back_to_goal', nudge.observationId)
            setNudge(null)
          }}
          onSnooze={() => {
            if (nudge) live.current?.socket.respond('snooze_10m', nudge.observationId)
            setNudge(null)
          }}
        />

        <Setup items={setup} />

        {view && inSession && android && grants.usage ? <PhoneToday view={view} blocked={view.data.blocklist.apps} /> : null}

        {view && android && grants.blocking ? <Blocking view={view} /> : null}

        <Footer
          name={pairing.phoneName}
          host={host}
          note={
            notice ?? (android ? null : 'On iPhone, Lumi hears motion and speaks; iOS hides other apps from it.')
          }
          onUnpair={() => void clearPairing().then(() => router.replace('/pair'))}
        />
      </ScrollView>
    </Screen>
  )
}
