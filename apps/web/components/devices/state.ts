import type { DeviceState } from '@heli/contracts'
import type { PillTone } from '@heli/ui'

export const STATE: Record<DeviceState, { label: string; tone: PillTone }> = {
  idle: { label: 'idle', tone: 'neutral' },
  armed: { label: 'armed', tone: 'neutral' },
  watching: { label: 'watching', tone: 'accent' },
  flagged: { label: 'off task', tone: 'warn' },
  speaking: { label: 'speaking', tone: 'accent' },
  shutter_closed: { label: 'shutter closed', tone: 'neutral' },
}
