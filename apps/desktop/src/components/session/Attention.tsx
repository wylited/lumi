import { useId, type ReactElement } from 'react'
import type { Goal, Observation } from '@heli/contracts'
import { mm } from './format'

interface Slice {
  name: string
  seconds: number
  onTask: boolean
  blocked: boolean
}

function slices(observations: Observation[], goal: Goal | null): { apps: Slice[]; sites: Slice[] } {
  const apps = new Map<string, Slice>()
  const sites = new Map<string, Slice>()
  const blocked = new Set(
    [...(goal?.blockedApps ?? []), ...(goal?.blockedSites ?? [])].map((b) => b.toLowerCase()),
  )
  for (const o of observations) {
    for (const a of o.signals.topApps) {
      const s = apps.get(a.app) ?? {
        name: a.app,
        seconds: 0,
        onTask: a.onTask,
        blocked: blocked.has(a.app.toLowerCase()),
      }
      s.seconds += a.seconds
      apps.set(a.app, s)
    }
    for (const t of o.signals.topSites) {
      const s = sites.get(t.title) ?? {
        name: t.title,
        seconds: 0,
        onTask: t.onTask,
        blocked: blocked.has(t.title.toLowerCase()),
      }
      s.seconds += t.seconds
      sites.set(t.title, s)
    }
  }
  const sort = (m: Map<string, Slice>) => [...m.values()].sort((a, b) => b.seconds - a.seconds)
  return { apps: sort(apps), sites: sort(sites) }
}

/** Where the session's time went: one bar of the session by app, the ranked list, and switching. */
export function Attention({
  observations,
  goal,
}: {
  observations: Observation[]
  goal: Goal | null
}) {
  const hatch = useId()
  const { apps, sites } = slices(observations, goal)
  const total = apps.reduce((n, a) => n + a.seconds, 0) || 1
  const ranked = [...apps.slice(0, 4), ...sites.slice(0, 3)]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 6)
  const switches = observations.slice(-30).map((o) => o.signals.contextSwitches)
  const peak = Math.max(4, ...switches)

  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-border p-5"
      aria-label="Where the time went"
    >
      <span className="text-small font-medium text-text-muted">Where the time went</span>
      {apps.length === 0 ? (
        <p className="text-body text-text-faint">Nothing yet.</p>
      ) : (
        <>
          <svg
            className="h-3 w-full overflow-hidden rounded-[3px]"
            preserveAspectRatio="none"
            viewBox="0 0 100 10"
            role="img"
            aria-label="Session time by app"
          >
            <defs>
              <pattern
                id={hatch}
                width="2"
                height="10"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="1" height="10" className="fill-warn" />
              </pattern>
            </defs>
            {
              apps.reduce<{ x: number; els: ReactElement[] }>(
                (acc, a) => {
                  const w = (a.seconds / total) * 100
                  acc.els.push(
                    <g key={a.name}>
                      <rect
                        x={acc.x}
                        y="0"
                        width={w}
                        height="10"
                        className={a.onTask ? 'fill-accent' : 'fill-warn/35'}
                      />
                      {a.blocked ? (
                        <rect x={acc.x} y="0" width={w} height="10" fill={`url(#${hatch})`} />
                      ) : null}
                      <title>{`${a.name} · ${mm(a.seconds)} · ${a.onTask ? 'on the goal' : 'off the goal'}${a.blocked ? ' · blocked' : ''}`}</title>
                    </g>,
                  )
                  acc.x += w
                  return acc
                },
                { x: 0, els: [] },
              ).els
            }
          </svg>
          <ol className="flex flex-col gap-1.5">
            {ranked.map((r) => (
              <li key={r.name} className="flex items-center gap-2.5 text-small">
                <span
                  className={
                    r.onTask ? 'size-1.5 rounded-pill bg-accent' : 'size-1.5 rounded-pill bg-warn'
                  }
                />
                <span className="min-w-0 flex-1 truncate text-text">{r.name}</span>
                {r.blocked ? <span className="text-caption text-warn">blocked</span> : null}
                <span className="tnum text-text-muted">{mm(r.seconds)}</span>
              </li>
            ))}
          </ol>
          <div className="flex items-end gap-3 border-t border-border pt-3">
            <svg
              viewBox={`0 0 ${Math.max(switches.length - 1, 1)} ${peak}`}
              preserveAspectRatio="none"
              className="h-8 flex-1"
              role="img"
              aria-label="Context switches per minute"
            >
              <polyline
                points={switches.map((v, i) => `${i},${peak - v}`).join(' ')}
                fill="none"
                className="stroke-text"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </svg>
            <span className="tnum text-caption text-text-faint">
              {switches.at(-1) ?? 0} switches this minute
            </span>
          </div>
        </>
      )}
    </section>
  )
}
