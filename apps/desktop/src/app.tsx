import { useCallback, useEffect, useState } from 'react'
import { NotificationLayer } from './components/notification/Layer'
import { Sidebar, ROUTES, type Route, type SidebarStatus } from './components/shell/Sidebar'
import { TitleBar } from './components/shell/TitleBar'
import { useDataSource } from './lib/api'
import { audio } from './lib/audio'
import { derive, useLive } from './lib/live'
import { native } from './lib/native'
import { setTray } from './lib/tray'
import { GoalRoute } from './routes/goal'
import { HistoryRoute } from './routes/history'
import { SettingsRoute } from './routes/settings'
import { SetupRoute } from './routes/setup'
import { setupDone } from './lib/setup'
import { LiveRoute } from './routes/live'

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
  // First run shows setup; Settings can bring it back with a `lumi:setup` event.
  const [setup, setSetup] = useState(() => !setupDone())
  useEffect(() => {
    const again = () => setSetup(true)
    window.addEventListener('lumi:setup', again)
    return () => window.removeEventListener('lumi:setup', again)
  }, [])
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

  const snap = useLive()
  const d = derive(snap)

  useEffect(() => native.attach(), [])

  // Web Audio starts suspended; the first click anywhere unlocks it for the session.
  useEffect(() => {
    const unlock = () => audio.resume()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])
  useEffect(() => setTray(d.tray), [d.tray])
  const status: SidebarStatus =
    snap.status !== 'live'
      ? { tone: 'idle', label: 'Not watching' }
      : d.tray === 'off_task'
        ? { tone: 'drift', label: 'Off task' }
        : d.tray === 'speaking'
          ? { tone: 'focus', label: 'Speaking' }
          : { tone: 'focus', label: 'Watching' }

  if (setup) {
    return (
      <>
        <SetupRoute
          onFinish={() => {
            setSetup(false)
            navigate('live')
          }}
        />
        <NotificationLayer />
      </>
    )
  }

  return (
    <div className="flex h-full bg-bg text-text">
      <Sidebar route={route} onNavigate={navigate} status={status} demo={source === 'demo'} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {route === 'live' ? (
            <LiveRoute />
          ) : route === 'goal' ? (
            <GoalRoute />
          ) : route === 'history' ? (
            <HistoryRoute />
          ) : (
            <SettingsRoute />
          )}
        </div>
      </main>
      <NotificationLayer />
    </div>
  )
}
