import { useEffect, useState } from 'react'
import { Pressable, useWindowDimensions, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { layout, space } from '@heli/tokens'

import { Ring } from '@/components/ring'
import { Text } from '@/components/ui'
import { clock, dur, greeting } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useTheme } from '@/lib/theme'

function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** Now: the session as the ring, the clock inside it, the goal under it. */
export default function Now() {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const { view, connection, playing, android } = useLive()
  const now = useNow()

  const session = view?.data.session ?? null
  const state = view?.data.state ?? 'waiting'
  const elapsedMs = session ? now - Date.parse(session.startedAt) : 0
  const size = Math.min(width - layout.gutter * 2, 340)
  const tone = state === 'off_goal' ? t.warn : state === 'focused' ? t.accent : t.textMuted
  const phone = view?.phone ?? null
  const blocked = view?.data.blocklist.active ? view.data.blocklist.apps.length : 0

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + space[4], paddingHorizontal: layout.gutter }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="small" tone="muted">
          {greeting(new Date(now))}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: connection === 'open' ? t.accent : connection === 'connecting' ? t.warn : t.textFaint,
            }}
          />
          <Text variant="small" tone="muted">
            {connection === 'open' ? 'With your Mac' : connection === 'connecting' ? 'Connecting' : 'Offline'}
          </Text>
        </View>
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[6] }}>
        <Ring
          size={size}
          speaking={playing}
          session={
            session
              ? { timeline: view?.data.timeline ?? [], elapsedMin: elapsedMs / 60_000, budgetMin: session.budgetMinutes }
              : null
          }
        >
          {session ? (
            <View style={{ alignItems: 'center', gap: space[2] }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: playing ? t.accent : tone }} />
                <Text variant="small" style={{ color: playing ? t.accent : tone, fontWeight: '600' }}>
                  {playing ? 'Lumi is speaking' : state === 'focused' ? 'On the goal' : state === 'off_goal' ? 'Off the goal' : 'Watching'}
                </Text>
              </View>
              <Text
                variant="display1"
                style={{ fontWeight: '600', letterSpacing: -1.5, fontVariant: ['tabular-nums'] }}
              >
                {clock(elapsedMs)}
              </Text>
              <Text variant="small" tone="faint">
                {session.budgetMinutes ? `of ${session.budgetMinutes} min` : 'no time budget'}
              </Text>
            </View>
          ) : (
            <View style={{ alignItems: 'center', gap: space[2], paddingHorizontal: space[10] }}>
              <Text variant="title2" style={{ fontWeight: '600' }}>
                {view === null ? 'Mac unreachable' : 'No session'}
              </Text>
              <Text variant="small" tone="muted" style={{ textAlign: 'center' }}>
                {view === null ? 'Lumi will reconnect on its own.' : 'Start one on your Mac. The ring fills as you work.'}
              </Text>
            </View>
          )}
        </Ring>

        {session ? (
          <Text variant="title3" style={{ fontWeight: '600', textAlign: 'center', paddingHorizontal: space[4] }} numberOfLines={2}>
            {session.goal}
          </Text>
        ) : null}
      </View>

      {session && android ? (
        <View
          style={{
            flexDirection: 'row',
            marginBottom: space[6],
            backgroundColor: t.surface,
            borderRadius: 20,
            paddingVertical: space[4],
          }}
        >
          <Fact value={phone ? dur(phone.seconds) : '—'} label="on the phone" onPress={() => router.navigate('/phone')} />
          <View style={{ width: 1, backgroundColor: t.border }} />
          <Fact value={phone ? String(phone.unlocks) : '—'} label="unlocks" onPress={() => router.navigate('/phone')} />
          <View style={{ width: 1, backgroundColor: t.border }} />
          <Fact value={String(blocked)} label="apps blocked" onPress={() => router.navigate('/blocking')} />
        </View>
      ) : (
        <View style={{ height: space[6] }} />
      )}
    </View>
  )
}

function Fact({ value, label, onPress }: { value: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1, alignItems: 'center', gap: 2 }} accessibilityRole="button">
      <Text variant="title3" style={{ fontWeight: '700', fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      <Text variant="caption" tone="faint">
        {label}
      </Text>
    </Pressable>
  )
}
