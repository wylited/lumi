import { useCallback, useEffect, useState } from 'react'
import { Pill } from '@heli/ui'
import { Sidebar, ROUTES, type Route, type SidebarStatus } from './components/shell/Sidebar'
import { TitleBar } from './components/shell/TitleBar'
import { useDataSource } from './lib/api'
import { setTray } from './lib/tray'
import { Placeholder } from './routes/placeholder'

const LAST_ROUTE = 'heli.route'

function initialRoute(): Route {
  try {
    const saved = localStorage.getItem(LAST_ROUTE)
    if (ROUTES.some((r) => r.id === saved)) return saved as Route
  } catch {
    // storage unavailable: fall through
  }
  return 'live'
}

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute)
  const source = useDataSource()

  const navigate = useCallback((next: Route) => {
    setRoute(next)
    try {
      localStorage.setItem(LAST_ROUTE, next)
    } catch {
      // per-viewer convenience only
    }
  }, [])

  // ⌘1–4, like every Mac app with a sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey || e.altKey || e.shiftKey) return
      const hit = ROUTES.find((r) => r.key === e.key)
      if (hit) {
        e.preventDefault()
        navigate(hit.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const status: SidebarStatus = { dot: 'idle', title: 'Idle', detail: 'No session running.' }
  useEffect(() => setTray('idle'), [])

  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[1]!

  return (
    <div className="flex h-full bg-bg text-text">
      <Sidebar
        route={route}
        onNavigate={navigate}
        status={status}
        footer={
          source === 'demo' ? (
            <Pill
              tone="warn"
              dot
              className="self-start"
              title="No server reachable — seeded demo data"
            >
              demo data
            </Pill>
          ) : null
        }
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TitleBar title={current.label} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Placeholder title={current.label} />
        </div>
      </main>
    </div>
  )
}
