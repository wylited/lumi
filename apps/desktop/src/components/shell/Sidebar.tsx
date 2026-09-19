import type { ReactNode } from 'react'
import { cn } from '@heli/ui'
import { Dot } from '../kit'
import { GoalIcon, HistoryIcon, LiveIcon, SettingsIcon } from './Icons'

export type Route = 'goal' | 'live' | 'history' | 'settings'

export const ROUTES: Array<{ id: Route; label: string; icon: ReactNode; key: string }> = [
  { id: 'live', label: 'Live', icon: <LiveIcon />, key: '1' },
  { id: 'goal', label: 'Goal', icon: <GoalIcon />, key: '2' },
  { id: 'history', label: 'History', icon: <HistoryIcon />, key: '3' },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, key: '4' },
]

export interface SidebarStatus {
  tone: 'focus' | 'drift' | 'idle'
  label: string
}

export function Sidebar({
  route,
  onNavigate,
  status,
  offline,
}: {
  route: Route
  onNavigate: (route: Route) => void
  status: SidebarStatus
  offline: boolean
}) {
  return (
    <aside className="flex w-[208px] shrink-0 flex-col border-r border-border bg-surface">
      {/* The traffic lights sit in this strip; it drags the window. */}
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <nav aria-label="Primary" className="flex flex-col gap-px px-2.5">
        {ROUTES.map((r) => {
          const active = r.id === route
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onNavigate(r.id)}
              aria-current={active ? 'page' : undefined}
              title={`${r.label}  ⌘${r.key}`}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-left text-body outline-none',
                'transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent',
                active
                  ? 'bg-ink-100 text-text'
                  : 'text-text-muted hover:bg-ink-100/60 hover:text-text',
              )}
            >
              <span className={active ? 'text-text' : 'text-text-faint'}>{r.icon}</span>
              {r.label}
            </button>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 px-5 pb-5">
        <span className="flex items-center gap-2 text-small text-text-muted">
          <Dot tone={status.tone} />
          {status.label}
        </span>
        {offline ? (
          <span className="pl-4 text-caption text-text-faint">Server unreachable</span>
        ) : null}
      </div>
    </aside>
  )
}
