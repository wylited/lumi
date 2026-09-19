import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Animated, Easing, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'

import type { MobileSession } from '@heli/contracts'

import { useTheme } from '@/lib/theme'

/**
 * The session as Lumi One's ring: sixty dots around a circle, lit clockwise from the top as the
 * session runs. Each dot is a slice of the budget (a minute when there is no budget), coloured by
 * what Lumi judged in it — jade on the goal, amber off it — and ringed where Lumi spoke.
 *
 * With no session a single dot circles slowly: it is watching for one. While Lumi speaks, the
 * ring breathes.
 */

const DOTS = 60

type Slot = 'on' | 'off' | 'none' | 'future'

function slots(timeline: MobileSession['timeline'], elapsedMin: number, budgetMin: number | null) {
  const span = budgetMin ? budgetMin / DOTS : 1
  const lit = Math.min(DOTS, Math.floor(elapsedMin / span) + 1)
  // Without a budget the ring shows the last hour: the oldest minutes roll off.
  const offset = budgetMin ? 0 : Math.max(0, timeline.length - DOTS)
  const out: { slot: Slot; spoke: boolean }[] = []
  for (let i = 0; i < DOTS; i += 1) {
    if (i >= lit) {
      out.push({ slot: 'future', spoke: false })
      continue
    }
    const from = Math.floor(offset + i * span)
    const to = Math.max(from + 1, Math.floor(offset + (i + 1) * span))
    const cells = timeline.slice(from, to)
    const slot: Slot = cells.some((c) => c.on === false)
      ? 'off'
      : cells.some((c) => c.on === true)
        ? 'on'
        : 'none'
    out.push({ slot, spoke: cells.some((c) => c.tier >= 3) })
  }
  return { out, current: lit - 1 }
}

export function Ring({
  size,
  session,
  speaking,
  children,
}: {
  size: number
  session: { timeline: MobileSession['timeline']; elapsedMin: number; budgetMin: number | null } | null
  speaking: boolean
  children?: ReactNode
}) {
  const t = useTheme()
  const r = size / 2 - 10
  const c = size / 2

  const { out, current } = useMemo(
    () => (session ? slots(session.timeline, session.elapsedMin, session.budgetMin) : { out: null, current: -1 }),
    [session],
  )

  // Idle: one dot travels the ring, a lap every six seconds.
  const [scan, setScan] = useState(0)
  useEffect(() => {
    if (session) return
    const timer = setInterval(() => setScan((s) => (s + 1) % DOTS), 100)
    return () => clearInterval(timer)
  }, [session])

  // Live: the current dot pulses. Speaking: the whole ring breathes.
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: speaking ? 520 : 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: speaking ? 520 : 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse, speaking])

  const color = (slot: Slot) =>
    slot === 'on' ? t.accent : slot === 'off' ? t.warn : slot === 'none' ? t.borderStrong : t.border

  const dots = Array.from({ length: DOTS }, (_, i) => {
    const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2
    const x = c + r * Math.cos(a)
    const y = c + r * Math.sin(a)
    if (!out) {
      const d = (i - scan + DOTS) % DOTS
      const glow = d === 0 ? 1 : d > DOTS - 6 ? (6 - (DOTS - d)) / 6 : 0
      return (
        <Circle key={i} cx={x} cy={y} r={glow > 0 ? 3.2 + glow * 1.6 : 3.2} fill={glow > 0 ? t.accent : t.border} opacity={glow > 0 ? 0.35 + glow * 0.65 : 1} />
      )
    }
    const { slot, spoke } = out[i]!
    return (
      <Circle
        key={i}
        cx={x}
        cy={y}
        r={spoke ? 5.4 : slot === 'future' ? 2.6 : slot === 'none' ? 3.4 : 4.6}
        fill={color(slot)}
        stroke={spoke ? t.text : 'none'}
        strokeWidth={spoke ? 1.4 : 0}
      />
    )
  })

  const cur = current >= 0 ? (current / DOTS) * Math.PI * 2 - Math.PI / 2 : 0
  const curSlot = out && current >= 0 ? out[current]!.slot : 'none'

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {speaking ? (
        <Animated.View
          style={{
            position: 'absolute',
            width: size - 36,
            height: size - 36,
            borderRadius: size,
            backgroundColor: t.accentWash,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.02] }) }],
          }}
        />
      ) : null}
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        {dots}
      </Svg>
      {out && current >= 0 ? (
        <Animated.View
          style={{
            position: 'absolute',
            left: c + r * Math.cos(cur) - 9,
            top: c + r * Math.sin(cur) - 9,
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: color(curSlot === 'none' ? 'on' : curSlot),
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.4] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.25] }) }],
          }}
        />
      ) : null}
      {children}
    </View>
  )
}
