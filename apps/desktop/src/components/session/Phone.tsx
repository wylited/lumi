import type { Goal, PhoneMotion } from '@heli/contracts'
import { cn } from '@heli/ui'
import { usePhoneSession } from '../../lib/phone'
import { dur } from './format'

const FRESH_MS = 2 * 60_000

const MOTION: Record<PhoneMotion, string> = {
  still: 'still',
  walking: 'walking',
  running: 'running',
  driving: 'driving',
  unknown: 'not reporting',
}

function seen(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 10 ? 'live' : s < 60 ? `seen ${s} s ago` : `seen ${Math.round(s / 60)} min ago`
}

/** The paired phone during a session: where it is, what is on it, and its share of the session. */
export function Phone({ sessionId, goal }: { sessionId: string | null; goal: Goal | null }) {
  const s = usePhoneSession(sessionId)
  if (s === undefined) return null
  if (s === null) {
    return (
      <p className="text-small text-text-faint">
        No phone paired. Pair one in Settings to see it here.
      </p>
    )
  }

  const { phone } = s
  const fresh = Date.now() - Date.parse(phone.lastSeenAt) <= FRESH_MS
  const android = phone.platform === 'android'
  const blocked = new Set((goal?.blockedApps ?? []).map((a) => a.toLowerCase()))
  const peak = Math.max(1, ...s.apps.map((a) => a.seconds))

  return (
    <section className="flex flex-col gap-4 rounded-md border border-border p-5" aria-label="Phone">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-small font-medium text-text-muted">
          Phone <span className="font-normal text-text-faint">· {phone.name}</span>
        </span>
        <span className="flex items-center gap-1.5 text-small text-text-faint">
          <span className={cn('size-1.5 rounded-pill', fresh ? 'bg-accent' : 'bg-ink-300')} />
          {seen(phone.lastSeenAt)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
        <Stat
          label="Where"
          value={!fresh ? '—' : phone.away ? 'Away' : 'At the desk'}
          detail={fresh ? MOTION[phone.motion] : 'no recent signal'}
          warn={fresh && phone.away}
        />
        <Stat
          label="Screen"
          value={phone.screenOn === null ? '—' : phone.screenOn ? 'On' : 'Off'}
          detail={phone.screenOn && phone.app ? phone.app : android ? 'locked or idle' : 'iOS hides the app'}
          warn={phone.screenOn === true && !!phone.app && blocked.has(phone.app.toLowerCase())}
        />
        <Stat label="Unlocks" value={android ? String(s.unlocks) : '—'} detail="this session" />
        <Stat label="Phone time" value={android ? dur(s.seconds) : '—'} detail="this session" />
      </dl>

      {android ? (
        s.apps.length === 0 ? (
          <p className="text-small text-text-faint">No app time on the phone this session.</p>
        ) : (
          <ol className="flex flex-col gap-1.5 border-t border-border pt-3">
            {s.apps.slice(0, 5).map((a) => {
              const off = blocked.has(a.app.toLowerCase())
              return (
                <li key={a.app} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-small">
                  <span className="truncate text-text">{a.app}</span>
                  <span className="h-1.5 overflow-hidden rounded-pill bg-ink-100">
                    <span
                      className={cn('block h-full rounded-pill', off ? 'bg-warn' : 'bg-ink-400')}
                      style={{ width: `${(a.seconds / peak) * 100}%` }}
                    />
                  </span>
                  <span className="tnum text-text-muted">{dur(a.seconds)}</span>
                </li>
              )
            })}
          </ol>
        )
      ) : (
        <p className="text-small text-text-faint">
          An iPhone reports motion and the screen only; iOS does not let an app read other apps&rsquo;
          time.
        </p>
      )}
    </section>
  )
}

function Stat({
  label,
  value,
  detail,
  warn = false,
}: {
  label: string
  value: string
  detail: string
  warn?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-caption text-text-faint">{label}</dt>
      <dd className={cn('tnum text-title-3 font-semibold', warn ? 'text-warn' : 'text-text')}>{value}</dd>
      <dd className="truncate text-caption text-text-faint">{detail}</dd>
    </div>
  )
}
