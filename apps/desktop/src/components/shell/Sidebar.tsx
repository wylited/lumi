import type { ReactNode } from 'react'
import { cn, LiveDot, type LiveState } from '@heli/ui'
import { GoalIcon, HistoryIcon, LiveIcon, SettingsIcon } from './Icons'
import { Mark } from './Mark'

export type Route = 'goal' | 'live' | 'history' | 'settings'

export const ROUTES: Array<{ id: Route; label: string; icon: ReactNode; key: string }> = [
  { id: 'goal', label: 'Goal', icon: <GoalIcon />, key: '1' },
  { id: 'live', label: 'Live', icon: <LiveIcon />, key: '2' },
  { id: 'history', label: 'History', icon: <HistoryIcon />, key: '3' },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, key: '4' },
]

export interface SidebarStatus {
  dot: LiveState
  title: string
  detail: string
}

export function Sidebar({
  route,
  onNavigate,
  status,
  footer,
}: {
  route: Route
  onNavigate: (route: Route) => void
  status: SidebarStatus
  footer?: ReactNode
}) {
  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-border bg-surface">
      {/* The traffic lights sit in this strip; the whole strip drags the window. */}
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-1" data-tauri-drag-region>
        <Mark className="size-[22px]" />
        <span className="text-body-strong font-semibold tracking-tight text-text">Helicopter</span>
      </div>

      <nav aria-label="Primary" className="flex flex-col gap-0.5 px-3">
        {ROUTES.map((r) => {
          const active = r.id === route
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onNavigate(r.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex h-9 items-center gap-3 rounded-sm px-3 text-left text-small font-medium outline-none',
                'transition-colors duration-fast ease-heli focus-visible:ring-2 focus-visible:ring-accent',
                active
                  ? 'bg-surface-raised text-text shadow-sm'
                  : 'text-text-muted hover:bg-surface-raised/60 hover:text-text',
              )}
            >
              <span
                className={cn(
                  active ? 'text-accent' : 'text-text-faint group-hover:text-text-muted',
                )}
              >
                {r.icon}
              </span>
              <span className="flex-1">{r.label}</span>
              <kbd className="font-mono text-[10.5px] text-text-faint opacity-0 transition-opacity duration-fast group-hover:opacity-100">
                ⌘{r.key}
              </kbd>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 p-3">
        <div className="rounded-md border border-border bg-surface-raised p-3.5">
          <div className="flex items-center gap-2">
            <LiveDot state={status.dot} />
            <span className="text-small font-medium text-text">{status.title}</span>
          </div>
          <p className="mt-1.5 line-clamp-2 text-caption text-text-faint">{status.detail}</p>
        </div>
        {footer}
      </div>
    </aside>
  )
}
