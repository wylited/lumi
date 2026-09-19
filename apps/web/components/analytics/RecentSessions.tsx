import Link from 'next/link'
import type { Session } from '@heli/contracts'

import { clock, day, duration } from '@/lib/format'

export function RecentSessions({ sessions }: { sessions: Session[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {sessions.map((s) => {
        const sum = s.summary
        const total = sum ? sum.focusedMinutes + sum.offTaskMinutes : 0
        const ratio = sum && total ? sum.focusedMinutes / total : null
        return (
          <li key={s.id}>
            <Link
              href={`/sessions/${s.id}`}
              className="group -mx-3 grid grid-cols-[120px_1fr_auto] items-center gap-5 rounded-sm px-3 py-3 transition-colors duration-fast hover:bg-surface"
            >
              <span className="flex flex-col">
                <span className="text-small text-text">{day(s.startedAt)}</span>
                <span className="tnum text-caption text-text-faint">
                  {clock(s.startedAt)} · {s.durationMs ? duration(s.durationMs / 1000) : 'live'}
                </span>
              </span>
              <span className="truncate text-small text-text-muted">
                {sum?.message ?? 'In progress'}
              </span>
              <span className="tnum text-small text-text">
                {ratio === null ? '—' : `${Math.round(ratio * 100)}%`}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
