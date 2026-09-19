import { useEffect, useState } from 'react'
import type { SessionDetail } from '@heli/contracts'
import { Figure, PageTitle, SectionTitle } from '../components/kit'
import { Hours } from '../components/history/Hours'
import { Pulls } from '../components/history/Pulls'
import { SessionSheet } from '../components/history/SessionSheet'
import { WeekChart } from '../components/history/WeekChart'
import { Worked } from '../components/history/Worked'
import { clock, mm } from '../components/session/format'
import { Ribbon } from '../components/session/Ribbon'
import { api } from '../lib/api'
import { bestTier, byDay, loadHistory, tierEffects, type History } from '../lib/analytics'
import { logger } from '../lib/log'

const log = logger('history')
const INSIGHT: Record<number, string> = {
  1: 'The light alone',
  2: 'A nudge',
  3: 'A spoken line',
  4: 'An automatic change',
}

export function HistoryRoute() {
  const [h, setH] = useState<History | null>(null)
  const [recent, setRecent] = useState<SessionDetail[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    loadHistory()
      .then(async (hist) => {
        setH(hist)
        const details = await Promise.all(hist.sessions.slice(0, 8).map((s) => api.session(s.id)))
        setRecent(details.filter((d): d is SessionDetail => d !== null))
      })
      .catch((e: unknown) => log.error('could not load history', e))
  }, [])

  if (!h) return null
  const effects = tierEffects(h.tiers)
  const best = bestTier(effects)
  const total = h.summary.focusedMinutes + h.summary.offTaskMinutes

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-12 px-10 pb-16 pt-2">
      <div className="flex flex-col gap-6">
        <PageTitle aside={<span className="text-small text-text-faint">Last 7 days</span>}>
          History
        </PageTitle>
        <div className="flex gap-14">
          <Figure value={mm(h.summary.focusedMinutes * 60)} label="Focused" />
          <Figure
            value={total ? `${Math.round((h.summary.focusedMinutes / total) * 100)}%` : '—'}
            label="On the goal"
          />
          <Figure value={mm(h.summary.longestFocusRunSeconds)} label="Longest run" />
          <Figure value={String(h.sessions.length)} label="Sessions" />
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <SectionTitle aside="focused and off task, per day">Time</SectionTitle>
        <WeekChart days={byDay(h.sessions)} />
      </section>

      <div className="grid gap-12 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <SectionTitle>What brings you back</SectionTitle>
          {best ? (
            <p className="-mt-2 text-small text-text-muted">
              {INSIGHT[best.tier]} works {Math.round((best.rate ?? 0) * 100)}% of the time.
            </p>
          ) : null}
          <Worked effects={effects} best={best} />
        </section>
        <section className="flex flex-col gap-4">
          <SectionTitle>What pulls you away</SectionTitle>
          <Pulls rows={h.apps} />
        </section>
      </div>

      <section className="flex flex-col gap-4">
        <SectionTitle aside="share on the goal">By hour</SectionTitle>
        <Hours rows={h.heatmap} />
      </section>

      <section className="flex flex-col gap-1">
        <SectionTitle>Sessions</SectionTitle>
        <ul className="flex flex-col divide-y divide-border">
          {recent.map((s) => {
            const sum = s.summary
            const t = sum ? sum.focusedMinutes + sum.offTaskMinutes : 0
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setOpen(s.id)}
                  className="-mx-3 grid w-[calc(100%+24px)] grid-cols-[130px_1fr_48px] items-center gap-5 rounded-sm px-3 py-3 text-left outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex flex-col">
                    <span className="text-small text-text">
                      {new Date(s.startedAt).toLocaleDateString('en-GB', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    <span className="tnum text-caption text-text-faint">
                      {clock(s.startedAt)} · {s.durationMs ? mm(s.durationMs / 1000) : '—'}
                    </span>
                  </span>
                  <Ribbon observations={s.observations} size="sm" />
                  <span className="tnum text-right text-small text-text">
                    {t ? `${Math.round((sum!.focusedMinutes / t) * 100)}%` : '—'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <SessionSheet id={open} onClose={() => setOpen(null)} />
    </div>
  )
}
