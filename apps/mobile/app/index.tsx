import { useEffect, useRef, useState } from 'react'
import { AppState, Platform, ScrollView } from 'react-native'
import { Redirect, router } from 'expo-router'

import { space } from '@heli/tokens'

import { BlockerCard } from '@/components/BlockerCard'
import { Button, Card, Dot, Label, Row, Screen, Text } from '@/components/ui'
import { clearPairing, usePairing } from '@/lib/store'
import { useTheme } from '@/lib/theme'
import { createSignalSampler, type SignalSampler } from '@/lib/signals'
import { createPhoneSocket, type Nudge, type PhoneSocket } from '@/lib/socket'
import { hasUsagePermission, openUsageSettings, usageStatsAvailable } from '@/lib/usage'

/**
 * The live screen: what this phone reports, what the observer said back, and the
 * one permission Android needs for the app part of it.
 *
 * Deliberately quiet. The phone is a surface, not a dashboard: the person opens
 * it to check the pairing is alive or to answer a nudge, and closes it again.
 */
export default function PhoneScreen() {
  const t = useTheme()
  const { ready, pairing } = usePairing()

  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [nudge, setNudge] = useState<Nudge | null>(null)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(0)
  const [usageOk, setUsageOk] = useState<boolean | null>(null)

  const live = useRef<{ sampler: SignalSampler; socket: PhoneSocket } | null>(null)

  useEffect(() => {
    if (pairing === null) return

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

    const tick = setInterval(() => setWaiting(sampler.pending()), 1_000)
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void hasUsagePermission().then(setUsageOk)
    })

    void hasUsagePermission().then(setUsageOk)

    return () => {
      clearInterval(tick)
      appState.remove()
      socket.stop()
      sampler.stop()
      live.current = null
    }
  }, [pairing?.serverUrl, pairing?.token, pairing?.phoneName])

  if (!ready) return null
  if (pairing === null) return <Redirect href="/pair" />

  const connected = connection === 'open'
  const host = pairing.serverUrl.replace(/^https?:\/\//, '')

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space[4], paddingVertical: space[6] }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row>
            <Text variant="title2">Lumi</Text>
            <Text variant="caption" tone="faint" style={{ marginLeft: space[2] }}>
              {pairing.phoneName}
            </Text>
          </Row>
          <Row>
            <Dot tone={connected ? 'on' : connection === 'connecting' ? 'warn' : 'off'} />
            <Text variant="caption" tone="muted">
              {connected ? `live · ${host}` : connection === 'connecting' ? 'connecting…' : 'offline'}
            </Text>
          </Row>
        </Row>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Label>Speaking now</Label>
            {playing ? <Dot tone="on" pulse /> : null}
          </Row>
          <Text variant="small" tone={playing ? 'text' : 'faint'}>
            {playing
              ? 'A line from the observer is playing through this phone.'
              : 'Silence. Most of the time the observer has nothing to say.'}
          </Text>
        </Card>

        {nudge !== null ? (
          <Card style={{ borderColor: t.accent, backgroundColor: t.accentWash }}>
            <Label>Lumi says</Label>
            <Text variant="bodyStrong">{nudge.message}</Text>
            <Row style={{ gap: space[2] }}>
              <Button
                label="Back to it"
                onPress={() => {
                  live.current?.socket.respond('back_to_goal', nudge.observationId)
                  setNudge(null)
                }}
              />
              <Button
                label="10 minutes"
                tone="quiet"
                onPress={() => {
                  live.current?.socket.respond('snooze_10m', nudge.observationId)
                  setNudge(null)
                }}
              />
            </Row>
          </Card>
        ) : null}

        <Card>
          <Label>What this phone reports</Label>
          <Text variant="small" tone="muted">
            Motion (still or walking), whether the screen is on, and — with usage access — the app in
            front, time in each app and unlocks. No messages, no content, ever.
          </Text>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="faint">
              {waiting} signal{waiting === 1 ? '' : 's'} waiting
            </Text>
            <Text variant="caption" tone="faint">
              {connected ? 'flushing every 5 s' : 'buffered until the socket returns'}
            </Text>
          </Row>
        </Card>

        {Platform.OS === 'android' ? (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Label>Usage access</Label>
              {usageOk === true ? (
                <Text variant="caption" tone="accent">
                  granted
                </Text>
              ) : usageOk === false ? (
                <Text variant="caption" tone="warn">
                  not granted
                </Text>
              ) : null}
            </Row>
            <Text variant="small" tone="muted">
              {usageStatsAvailable
                ? 'Android app time and unlock counts come from this. It is a special access, granted in Settings.'
                : 'This build has no usage-stats module — install a development build to see app time. Motion and speech still work.'}
            </Text>
            {usageOk === false && usageStatsAvailable ? (
              <Button label="Open usage access settings" tone="quiet" onPress={() => void openUsageSettings()} />
            ) : null}
          </Card>
        ) : (
          <Card>
            <Label>iOS, honestly</Label>
            <Text variant="small" tone="muted">
              iOS does not let an app read other apps' time without Apple's Screen Time entitlement.
              This phone reports motion and receives nudges and speech; it does not pretend to watch
              the screen.
            </Text>
          </Card>
        )}

        {Platform.OS === 'android' ? <BlockerCard serverUrl={pairing.serverUrl} token={pairing.token} /> : null}

        {notice !== null ? (
          <Text variant="caption" tone="faint" numberOfLines={2}>
            {notice}
          </Text>
        ) : null}

        <Button
          label="Unpair this phone"
          tone="quiet"
          onPress={() => {
            void clearPairing().then(() => router.replace('/pair'))
          }}
        />
      </ScrollView>
    </Screen>
  )
}
