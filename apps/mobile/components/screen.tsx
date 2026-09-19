import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native'

import { radius, space } from '@heli/tokens'

import { Button, Text } from '@/components/ui'
import type { SessionView } from '@/lib/session'
import type { Nudge } from '@/lib/socket'
import { useTheme } from '@/lib/theme'

/* ---- pieces ---------------------------------------------------------------- */

function dur(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="label" tone="faint" style={{ textTransform: 'uppercase' }}>
          {label}
        </Text>
        {aside}
      </View>
      {children}
    </View>
  )
}

function Hairline() {
  const t = useTheme()
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} />
}

/* ---- header ------------------------------------------------------------------ */

export function Header({ connection }: { connection: 'connecting' | 'open' | 'closed' }) {
  const t = useTheme()
  const color = connection === 'open' ? t.accent : connection === 'connecting' ? t.warn : t.textFaint
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text variant="title3" style={{ fontWeight: '700', letterSpacing: -0.4 }}>
        lumi
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: space[3],
          paddingVertical: 6,
          borderRadius: radius.pill,
          backgroundColor: t.surface,
        }}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        <Text variant="caption" tone="muted">
          {connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}
        </Text>
      </View>
    </View>
  )
}

/* ---- the session ----------------------------------------------------------- */

export function SessionHero({ view }: { view: SessionView | null | undefined }) {
  const t = useTheme()
  const now = useNow()
  const session = view?.data.session ?? null

  if (!session) {
    return (
      <View style={{ gap: space[2], paddingVertical: space[4] }}>
        <Text variant="label" tone="faint" style={{ textTransform: 'uppercase' }}>
          {view === null ? 'Server unreachable' : 'No session'}
        </Text>
        <Text variant="title1" style={{ fontWeight: '600', letterSpacing: -0.6 }}>
          Nothing to watch yet.
        </Text>
        <Text variant="body" tone="muted">
          Start a session on your Mac. This screen follows it, and so does your phone.
        </Text>
      </View>
    )
  }

  const elapsed = now - Date.parse(session.startedAt)
  const budgetMs = session.budgetMinutes ? session.budgetMinutes * 60_000 : null
  const progress = budgetMs ? Math.min(1, elapsed / budgetMs) : null
  const state = view?.data.state ?? 'waiting'
  const tone = state === 'off_goal' ? t.warn : state === 'focused' ? t.accent : t.textFaint

  return (
    <View style={{ gap: space[4], paddingVertical: space[2] }}>
      <View style={{ gap: space[2] }}>
        <Text variant="label" tone="faint" style={{ textTransform: 'uppercase' }}>
          Session · {Math.floor(elapsed / 60_000)} min in
        </Text>
        <Text variant="title1" style={{ fontWeight: '600', letterSpacing: -0.6 }} numberOfLines={3}>
          {session.goal}
        </Text>
      </View>

      {progress !== null ? (
        <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: t.surfaceRaised, overflow: 'hidden' }}>
          <View style={{ width: `${progress * 100}%`, height: '100%', backgroundColor: tone }} />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
          <Text variant="bodyStrong" style={{ color: state === 'waiting' ? t.textMuted : tone }}>
            {state === 'focused' ? 'On the goal' : state === 'off_goal' ? 'Off the goal' : 'Watching'}
          </Text>
        </View>
        <Text variant="body" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {clock(elapsed)}
          {session.budgetMinutes ? ` / ${session.budgetMinutes} min` : ''}
        </Text>
      </View>
    </View>
  )
}

/* ---- the moment: a line playing, or a nudge waiting ------------------------- */

function Wave() {
  const t = useTheme()
  const bars = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0.3))).current
  useEffect(() => {
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: 320 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 320 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [bars])
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 18 }}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: t.accent, transform: [{ scaleY: v }] }}
        />
      ))}
    </View>
  )
}

export function Moment({
  playing,
  nudge,
  onBack,
  onSnooze,
}: {
  playing: boolean
  nudge: Nudge | null
  onBack: () => void
  onSnooze: () => void
}) {
  const t = useTheme()
  if (!playing && !nudge) return null
  return (
    <View
      style={{
        backgroundColor: t.accentWash,
        borderRadius: radius.lg,
        padding: space[5],
        gap: space[4],
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.accent,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        {playing ? <Wave /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} />}
        <Text variant="small" tone="muted">
          {playing ? 'Lumi is speaking, through this phone' : 'Lumi says'}
        </Text>
      </View>
      {nudge ? (
        <>
          <Text variant="title3" style={{ fontWeight: '600' }}>
            {nudge.message}
          </Text>
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <View style={{ flex: 1 }}>
              <Button label="Back to it" onPress={onBack} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="10 minutes" tone="quiet" onPress={onSnooze} />
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}

/* ---- this session on the phone ------------------------------------------------ */

export function PhoneToday({ view, blocked }: { view: SessionView; blocked: string[] }) {
  const t = useTheme()
  const phone = view.phone
  const snapshot = view.data.phone
  const motion = snapshot?.motion ?? 'unknown'
  if (!phone) return null
  const peak = Math.max(1, ...phone.apps.map((a) => a.seconds))
  const listed = new Set(blocked.map((b) => b.toLowerCase()))

  return (
    <Section label="This session on your phone">
      <View style={{ flexDirection: 'row', gap: space[3] }}>
        <Stat value={dur(phone.seconds)} label="phone time" />
        <Stat value={String(phone.unlocks)} label="unlocks" />
        <Stat value={motion === 'unknown' ? '—' : motion[0]!.toUpperCase() + motion.slice(1)} label="right now" />
      </View>
      {phone.apps.length > 0 ? (
        <View style={{ gap: space[2], paddingTop: space[1] }}>
          {phone.apps.slice(0, 4).map((a) => {
            const off = listed.has(a.app.toLowerCase())
            return (
              <View key={a.app} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                <Text variant="small" style={{ width: 96 }} numberOfLines={1}>
                  {a.app}
                </Text>
                <View style={{ flex: 1, height: 6, borderRadius: radius.pill, backgroundColor: t.surfaceRaised, overflow: 'hidden' }}>
                  <View
                    style={{
                      width: `${(a.seconds / peak) * 100}%`,
                      height: '100%',
                      borderRadius: radius.pill,
                      backgroundColor: off ? t.warn : t.textFaint,
                    }}
                  />
                </View>
                <Text variant="small" tone="muted" style={{ width: 44, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                  {dur(a.seconds)}
                </Text>
              </View>
            )
          })}
        </View>
      ) : (
        <Text variant="small" tone="faint">
          No app time yet this session.
        </Text>
      )}
      <Text variant="caption" tone="faint">
        Counts and app names only. Never messages, never what is on the screen.
      </Text>
    </Section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  const t = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: t.surface, borderRadius: radius.md, padding: space[3], gap: 2 }}>
      <Text variant="title3" style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      <Text variant="caption" tone="faint">
        {label}
      </Text>
    </View>
  )
}

/* ---- blocking ------------------------------------------------------------------ */

export function Blocking({ view }: { view: SessionView }) {
  const t = useTheme()
  const list = view.data.blocklist
  return (
    <Section
      label="Blocking"
      aside={
        <Text variant="caption" tone={list.active ? 'accent' : 'faint'}>
          {list.active ? 'on' : 'idle'}
        </Text>
      }
    >
      {list.active ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {list.apps.map((app) => (
            <View
              key={app}
              style={{ paddingHorizontal: space[3], paddingVertical: 6, borderRadius: radius.pill, backgroundColor: t.warnWash }}
            >
              <Text variant="small" style={{ color: t.warn }}>
                {app}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text variant="small" tone="muted">
        {list.active
          ? 'Open one and Lumi sends you home, then tells you. Undo from the notification.'
          : 'During a session, Lumi sends you home from apps your goal blocks — when the goal allows it.'}
      </Text>
    </Section>
  )
}

/* ---- setup: only what is missing ---------------------------------------------- */

export interface SetupItem {
  key: string
  title: string
  detail: string
  action: string
  onPress: () => void
}

export function Setup({ items }: { items: SetupItem[] }) {
  const t = useTheme()
  if (items.length === 0) return null
  return (
    <Section label={`Finish setting up · ${items.length}`}>
      <View style={{ backgroundColor: t.surface, borderRadius: radius.md }}>
        {items.map((item, i) => (
          <View key={item.key}>
            {i > 0 ? <Hairline /> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], padding: space[4] }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong">{item.title}</Text>
                <Text variant="small" tone="muted">
                  {item.detail}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={item.onPress}
                style={({ pressed }) => ({
                  paddingHorizontal: space[4],
                  minHeight: 36,
                  justifyContent: 'center',
                  borderRadius: radius.pill,
                  backgroundColor: t.accent,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text variant="small" style={{ color: t.accentContrast, fontWeight: '600' }}>
                  {item.action}
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </Section>
  )
}

/* ---- footer ------------------------------------------------------------------- */

export function Footer({ name, host, note, onUnpair }: { name: string; host: string; note: string | null; onUnpair: () => void }) {
  return (
    <View style={{ gap: space[2], paddingTop: space[4], alignItems: 'center' }}>
      {note ? (
        <Text variant="caption" tone="faint" numberOfLines={2} style={{ textAlign: 'center' }}>
          {note}
        </Text>
      ) : null}
      <Text variant="caption" tone="faint">
        {name} · {host}
      </Text>
      <Pressable accessibilityRole="button" onPress={onUnpair} hitSlop={12}>
        <Text variant="caption" tone="muted" style={{ textDecorationLine: 'underline' }}>
          Unpair this phone
        </Text>
      </Pressable>
    </View>
  )
}
