import Link from 'next/link'
import type { Device, Goal } from '@heli/contracts'
import { LiveDot, Pill } from '@heli/ui'
import { relative } from '@/lib/format'
import { STATE } from './state'

export function DeviceRow({ device, goal }: { device: Device; goal: Goal | null }) {
  const state = device.state ? STATE[device.state] : null
  return (
    <Link
      href={`/devices/${device.id}`}
      className="group grid items-center gap-6 rounded-md border border-border bg-surface-raised p-5 transition-colors duration-base hover:border-border-strong md:grid-cols-[1.2fr_1fr_1fr_auto]"
    >
      <span className="flex items-center gap-3">
        <LiveDot
          state={device.online ? (device.state === 'speaking' ? 'speaking' : 'live') : 'idle'}
        />
        <span className="flex flex-col">
          <span className="text-body-strong font-semibold text-text">{device.name}</span>
          <span className="text-caption text-text-faint">
            {device.online ? 'online' : 'offline'}
            {device.lastSeenAt ? ` · seen ${relative(device.lastSeenAt)}` : ''}
          </span>
        </span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-label uppercase text-text-faint">Running</span>
        <span className="truncate text-small text-text">{goal?.objective ?? 'no goal'}</span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-label uppercase text-text-faint">Unit</span>
        <span className="text-small text-text-muted">
          {device.caps.camera} · {device.caps.mics} mic{device.caps.mics === 1 ? '' : 's'}
          {device.caps.speaker ? ' · speaker' : ''}
          {device.caps.shutter ? ' · shutter' : ''}
        </span>
      </span>
      {state ? (
        <Pill tone={state.tone} dot>
          {state.label}
        </Pill>
      ) : (
        <Pill>unknown</Pill>
      )}
    </Link>
  )
}
