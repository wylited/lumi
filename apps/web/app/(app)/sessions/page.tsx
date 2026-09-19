import type { Metadata } from 'next'
import Link from 'next/link'
import type { SessionDetail } from '@heli/contracts'
import { EmptyState } from '@heli/ui'
import { Strip, StripLegend } from '@/components/session/Strip'
import { Page, PageHeader } from '@/components/shell/Page'
import { api } from '@/lib/api'
import { clock, day, duration, percent } from '@/lib/format'

export const metadata: Metadata = { title: 'Sessions' }

export default async function Sessions() {
  const list = (await api.sessions()).filter((s) => s.endedAt).slice(0, 24)
  // Each row draws its own strip, so it needs the observations. Fine at this scale.
  const details = (await Promise.all(list.map((s) => api.session(s.id)))).filter(
    (d): d is SessionDetail => d !== null,
  )

  const byDay = new Map<string, SessionDetail[]>()
  for (const d of details) {
    const key = day(d.startedAt)
    byDay.set(key, [...(byDay.get(key) ?? []), d])
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Replay"
        title="Sessions"
        lede="Every session, minute by minute. Green is the system staying quiet because you were on the goal."
        actions={<StripLegend />}
      />
      {details.length === 0 ? (
        <EmptyState title="No finished sessions yet. Start one from the desktop app." />
      ) : (
        <div className="flex flex-col gap-12">
          {[...byDay.entries()].map(([label, sessions]) => (
            <section key={label} className="flex flex-col gap-2">
              <h2 className="text-label uppercase text-text-faint">{label}</h2>
              <ul className="flex flex-col">
                {sessions.map((s) => (
                  <Row key={s.id} s={s} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Page>
  )
}

function Row({ s }: { s: SessionDetail }) {
  const sum = s.summary
  const tracked = sum ? sum.focusedMinutes + sum.offTaskMinutes : 0
  const loud = s.observations.filter((o) => o.tier >= 2).length
  return (
    <li>
      <Link
        href={`/sessions/${s.id}`}
        className="group -mx-4 grid grid-cols-[110px_1fr_150px] items-center gap-6 rounded-md px-4 py-4 transition-colors duration-fast hover:bg-surface"
      >
        <span className="flex flex-col">
          <span className="tnum text-body-strong font-medium text-text">{clock(s.startedAt)}</span>
          <span className="tnum text-caption text-text-faint">
            {s.durationMs ? duration(s.durationMs / 1000) : '—'}
          </span>
        </span>
        <Strip observations={s.observations} size="sm" />
        <span className="flex flex-col items-end">
          <span className="tnum text-small text-text">
            {tracked ? percent(sum!.focusedMinutes / tracked) : '—'} on goal
          </span>
          <span className="text-caption text-text-faint">
            {loud === 0
              ? 'nothing needed saying'
              : `${loud} ${loud === 1 ? 'interruption' : 'interruptions'}`}
          </span>
        </span>
      </Link>
    </li>
  )
}
