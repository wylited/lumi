import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'

import { layout, radius, space } from '@heli/tokens'

import { IconChevron } from '@/components/icons'
import { Button, Text } from '@/components/ui'
import type { Nudge } from '@/lib/socket'
import { useTheme } from '@/lib/theme'

/* ---- a tab's page ----------------------------------------------------------- */

export function Page({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + space[4],
          paddingHorizontal: layout.gutter,
          paddingBottom: space[10],
          gap: space[8],
        }}
        showsVerticalScrollIndicator={false}
      >
        {title ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space[3] }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="display2" style={{ fontWeight: '700', letterSpacing: -0.8 }}>
                {title}
              </Text>
              {subtitle ? (
                <Text variant="body" tone="muted">
                  {subtitle}
                </Text>
              ) : null}
            </View>
            {right}
          </View>
        ) : null}
        {children}
      </ScrollView>
    </View>
  )
}

export function Section({ label, aside, children, style }: { label?: string; aside?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ gap: space[3] }, style]}>
      {label ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 2 }}>
          <Text variant="small" tone="muted" style={{ fontWeight: '600' }}>
            {label}
          </Text>
          {aside}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/* ---- grouped rows, like a settings list ------------------------------------- */

export function Group({ children }: { children: ReactNode }) {
  const t = useTheme()
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean)
  return (
    <View style={{ backgroundColor: t.surface, borderRadius: radius.lg, overflow: 'hidden' }}>
      {items.map((child, i) => (
        <View key={i}>
          {i > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: space[4] }} /> : null}
          {child}
        </View>
      ))}
    </View>
  )
}

export function Item({
  leading,
  title,
  detail,
  value,
  valueTone = 'muted',
  onPress,
  danger = false,
}: {
  leading?: ReactNode
  title: string
  detail?: string
  value?: string
  valueTone?: 'muted' | 'accent' | 'warn' | 'faint'
  onPress?: () => void
  danger?: boolean
}) {
  const t = useTheme()
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], paddingVertical: 14, minHeight: 56 }}>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" style={{ fontWeight: '500', color: danger ? t.danger : t.text }}>
          {title}
        </Text>
        {detail ? (
          <Text variant="small" tone="faint">
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="small" tone={valueTone} style={{ fontWeight: '500' }}>
          {value}
        </Text>
      ) : null}
      {onPress && !danger ? <IconChevron color={t.textFaint} /> : null}
    </View>
  )
  return onPress ? (
    <Pressable onPress={onPress} android_ripple={{ color: t.border }} accessibilityRole="button">
      {body}
    </Pressable>
  ) : (
    body
  )
}

/* ---- an app, as a tile with its initial -------------------------------------- */

export function Monogram({ name, tone = 'plain', size = 36 }: { name: string; tone?: 'plain' | 'warn' | 'accent'; size?: number }) {
  const t = useTheme()
  const bg = tone === 'warn' ? t.warnWash : tone === 'accent' ? t.accentWash : t.surfaceRaised
  const fg = tone === 'warn' ? t.warn : tone === 'accent' ? t.accent : t.textMuted
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text variant="bodyStrong" style={{ color: fg, fontWeight: '700', fontSize: size * 0.42 }}>
        {name.trim().charAt(0).toUpperCase() || '·'}
      </Text>
    </View>
  )
}

/* ---- the nudge, over whichever tab is open ----------------------------------- */

export function NudgeSheet({ nudge, onAnswer }: { nudge: Nudge | null; onAnswer: (a: 'back_to_goal' | 'snooze_10m') => void }) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const rise = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(rise, {
      toValue: nudge ? 1 : 0,
      duration: 280,
      easing: Easing.bezier(0.2, 0.7, 0.3, 1),
      useNativeDriver: true,
    }).start()
  }, [nudge, rise])
  if (!nudge) return null
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: t.text, opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }) }]}
      />
      <Animated.View
        style={{
          position: 'absolute',
          left: space[3],
          right: space[3],
          bottom: insets.bottom + space[3],
          backgroundColor: t.bg,
          borderRadius: 28,
          padding: space[6],
          gap: space[5],
          transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [320, 0] }) }],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }} />
          <Text variant="small" tone="muted" style={{ fontWeight: '600' }}>
            Lumi
          </Text>
        </View>
        <Text variant="title2" style={{ fontWeight: '600', letterSpacing: -0.4 }}>
          {nudge.message}
        </Text>
        <View style={{ gap: space[2] }}>
          <Button label="Back to it" onPress={() => onAnswer('back_to_goal')} />
          <Button label="Give me 10 minutes" tone="quiet" onPress={() => onAnswer('snooze_10m')} />
        </View>
      </Animated.View>
    </View>
  )
}

/* ---- the tab bar -------------------------------------------------------------- */

type BottomTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0]

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: t.bg,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.border,
        paddingBottom: Math.max(insets.bottom, space[2]),
        paddingTop: space[2],
      }}
    >
      {state.routes.map((route, index) => {
        const focused = state.index === index
        const { options } = descriptors[route.key]!
        const color = focused ? t.text : t.textFaint
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name)
            }}
            focusable={false}
            style={{ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 6 }}
          >
            {options.tabBarIcon?.({ focused, color, size: 24 })}
            <Text variant="caption" style={{ color, fontWeight: focused ? '600' : '400' }}>
              {options.title ?? route.name}
            </Text>
            {options.tabBarBadge !== undefined ? (
              <View style={{ position: 'absolute', top: 4, right: '30%', width: 8, height: 8, borderRadius: 4, backgroundColor: t.warn }} />
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}
