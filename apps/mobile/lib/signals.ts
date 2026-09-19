import { AppState, Platform } from 'react-native'
import { Accelerometer } from 'expo-sensors'

import { PHONE_SIGNAL, type PhoneMotion, type Signal } from '@heli/contracts'

import { usageSinceLast } from './usage'

/**
 * What the phone knows, as contract signals.
 *
 * Everything is phone-scoped and honest: `device.state` from the app's own
 * lifecycle (we cannot see the screen from outside), motion from the
 * accelerometer (still or walking — "driving" is a claim this cannot support),
 * and app usage from the Android module, absent on iOS. The server's snapshot
 * carries the gap rather than treating it as a quiet person.
 */

const BUFFER_LIMIT = 500
const MOTION_POLL_MS = 500

export interface SignalSampler {
  start(): void
  stop(): void
  /** Drain the buffer, polling usage stats first (Android) so the batch is current. */
  collect(): Promise<Signal[]>
  pending(): number
}

const now = (): string => new Date().toISOString()

export function createSignalSampler(): SignalSampler {
  const buffer: Signal[] = []
  let appStateSub: { remove(): void } | null = null
  let motionSub: { remove(): void } | null = null
  let samples: number[] = []
  let lastMotion: PhoneMotion = 'unknown'
  let started = false

  const push = (kind: string, payload: Record<string, string | number | boolean | null>): void => {
    buffer.push({ source: 'phone', kind, ts: now(), confidence: 1, payload })
    if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
  }

  const onMotion = (reading: { x: number; y: number; z: number }): void => {
    const magnitude = Math.sqrt(reading.x * reading.x + reading.y * reading.y + reading.z * reading.z)
    samples.push(magnitude)
    if (samples.length < 8) return
    if (samples.length > 8) samples.shift()

    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
    // A phone in a pocket swings; a phone on a desk barely moves. The threshold
    // is deliberately wide: "walking" is a claim the tutor acts on.
    const next: PhoneMotion = variance > 0.35 ? 'walking' : 'still'

    if (next !== lastMotion) {
      lastMotion = next
      push(PHONE_SIGNAL.motion, { state: next })
    }
  }

  return {
    start() {
      if (started) return
      started = true

      push(PHONE_SIGNAL.state, { screen: 'on', unlocked: true })

      appStateSub = AppState.addEventListener('change', (next) => {
        push(PHONE_SIGNAL.state, { screen: next === 'active' ? 'on' : 'off', unlocked: next === 'active' })
      })

      if (Platform.OS === 'android' || Platform.OS === 'ios') {
        Accelerometer.setUpdateInterval(MOTION_POLL_MS)
        motionSub = Accelerometer.addListener(onMotion)
      }
    },

    stop() {
      started = false
      appStateSub?.remove()
      motionSub?.remove()
      appStateSub = null
      motionSub = null
      samples = []
      lastMotion = 'unknown'
    },

    async collect() {
      const usage = await usageSinceLast()
      if (usage !== null) {
        if (usage.foregroundApp !== null) {
          push(PHONE_SIGNAL.app, { app: usage.foregroundApp })
        }
        // Six apps is the window's top-app shape; more would be signal noise
        // pretending to be data.
        for (const entry of usage.apps.slice(0, 6)) {
          if (entry.seconds > 0) push(PHONE_SIGNAL.usage, { app: entry.app, seconds: entry.seconds })
        }
        if (usage.unlocks > 0) push(PHONE_SIGNAL.unlock, { count: usage.unlocks })
      }

      const drained = buffer.splice(0, buffer.length)
      return drained
    },

    pending() {
      return buffer.length
    },
  }
}
