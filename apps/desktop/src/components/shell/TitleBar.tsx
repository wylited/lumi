import type { ReactNode } from 'react'

/** The strip above the content. It drags the window and holds the route's title and actions. */
export function TitleBar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border px-8"
    >
      <h1 data-tauri-drag-region className="text-body-strong font-semibold text-text">
        {title}
      </h1>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}
