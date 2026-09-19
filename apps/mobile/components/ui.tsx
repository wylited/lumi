import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text as RNText, View, type TextStyle, type ViewStyle } from 'react-native'

import { layout, radius, space, type } from '@heli/tokens'

import { useTheme } from '../lib/theme'

type ScaleName = keyof typeof type.scale

export function Text({
  children,
  variant = 'body',
  tone = 'text',
  mono = false,
  style,
  numberOfLines,
}: {
  children: ReactNode
  variant?: ScaleName
  tone?: 'text' | 'muted' | 'faint' | 'accent' | 'warn' | 'danger' | 'contrast'
  mono?: boolean
  style?: TextStyle
  numberOfLines?: number
}) {
  const t = useTheme()
  const scale = type.scale[variant]
  const colors: Record<typeof tone, string> = {
    text: t.text,
    muted: t.textMuted,
    faint: t.textFaint,
    accent: t.accent,
    warn: t.warn,
    danger: t.danger,
    contrast: t.accentContrast,
  }

  return (
    <RNText
      numberOfLines={numberOfLines}
      style={[
        {
          color: colors[tone],
          fontSize: scale.size,
          lineHeight: Math.round(scale.size * scale.leading),
          letterSpacing: scale.tracking * scale.size,
          fontWeight: scale.weight as TextStyle['fontWeight'],
          fontFamily: mono ? type.family.mono : type.family.ui,
        },
        style,
      ]}
    >
      {children}
    </RNText>
  )
}

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme()
  return <View style={[{ flex: 1, backgroundColor: t.bg, padding: layout.gutter }, style]}>{children}</View>
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme()
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.md,
          padding: space[4],
          gap: space[2],
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export function Button({
  label,
  onPress,
  disabled = false,
  tone = 'accent',
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'accent' | 'quiet' | 'danger'
}) {
  const t = useTheme()
  const background = tone === 'accent' ? t.accent : tone === 'danger' ? t.dangerWash : t.surfaceRaised
  const color = tone === 'accent' ? t.accentContrast : tone === 'danger' ? t.danger : t.text

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: layout.tapTarget,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: space[4],
        borderRadius: radius.sm,
        backgroundColor: background,
        borderWidth: tone === 'quiet' ? StyleSheet.hairlineWidth : 0,
        borderColor: t.border,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text variant="bodyStrong" style={{ color }}>
        {label}
      </Text>
    </Pressable>
  )
}

export function Dot({ tone, pulse = false }: { tone: 'on' | 'off' | 'warn'; pulse?: boolean }) {
  const t = useTheme()
  const color = tone === 'on' ? t.accent : tone === 'warn' ? t.warn : t.textFaint
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: pulse ? 0.6 : 1 }} />
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <Text variant="label" tone="faint" style={{ textTransform: 'uppercase' }}>
      {children}
    </Text>
  )
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space[2] }, style]}>{children}</View>
  )
}
