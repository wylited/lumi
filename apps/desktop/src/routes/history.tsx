import { useEffect, useState } from 'react'
import { Card, CardBody, Stat } from '@heli/ui'
import { DayBars } from '../components/history/DayBars'
import { Effects } from '../components/history/Effects'
import { Hours } from '../components/history/Hours'
import { Pulls } from '../components/history/Pulls'
import { SessionSheet } from '../components/history/SessionSheet'
import { clock, dur, mins } from '../components/session/format'
import { bestTier, byDay, loadHistory, tierEffects, type History } from '../lib/analytics'
import { logger } from '../lib/log'

const log = logger('history')

const VERB: Record<number, string> = {
  1: 'The tray alone',
  2: 'A nudge',
  3: 'A spoken line',
  4: 'An automatic change',
}

export function HistoryRoute() {
  const [h, setH] = useState<History | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    loadHistory()
      .then(setH)
      .catch((e: unknown) => log.error('could not load history', e))
  }, [])

  if (!h) return null

  const effects = tierEffects(h.tiers)
  const best = bestTier(effects)
  const days = byDay(h.sessions)
  const total = h.summary.focusedMinutes + h.summary.offTaskMinutes
  const share = total ? h.summary.focusedMinutes / total : 0

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-8 px-8 py-8">
      <div className="flex flex-col gap-2">
        <span className="text-label uppercase text-text-faint">{h.sessions.length} sessions</span>
        <h2 className="text-display-2 font-semibold text-balance text-text">
          {best ? (
            <>
              {VERB[best.tier] ?? `Tier ${best.tier}`} brings you back{' '}
              <span className="text-accent-link">{Math.round((best.rate ?? 0) * 100)}%</span> of the
              time.
            </>
          ) : (
            'Not enough interventions yet to say what works.'
          )}
        </h2>
      </div>

      <div className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border">
        {[
          {
            label: 'Focused',
            value: mins(h.summary.focusedMinutes),
            unit: 'min',
            hint: `${Math.round(share * 100)}% of tracked`,
          },
          {
            label: 'Off task',
            value: mins(h.summary.offTaskMinutes),
            unit: 'min',
            hint: `${h.apps.filter((a) => !a.onTask).length} distinct pulls`,
          },
          { label: 'Longest run', value: dur(h.summary.longestFocusRunSeconds), hint: 'unbroken' },
          {
            label: 'Interventions',
            value: String(h.summary.interventions),
            hint: `${h.summary.tierHistogram['0'] ?? 0} windows silent`,
          },
        ].map((s) => (
          <div key={s.label} className="bg-bg px-5 py-4">
            <Stat label={s.label} value={s.value} unit={s.unit} hint={s.hint} />
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardBody className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between">
              <span className="text-label uppercase text-text-faint">The last seven days</span>
              <span className="flex items-center gap-4 text-caption text-text-faint">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-accent" /> focused
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px] bg-warn/80" /> off task
                </span>
              </span>
            </div>
            <DayBars days={days} />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-5">
            <span className="text-label uppercase text-text-faint">What gets you back</span>
            <Effects effects={effects} best={best} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <Card>
          <CardBody className="flex flex-col gap-5">
            <span className="text-label uppercase text-text-faint">What pulls you away</span>
            <Pulls rows={h.apps} />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-5">
            <span className="text-label uppercase text-text-faint">Focus by hour</span>
            <Hours rows={h.heatmap} />
          </CardBody>
        </Card>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-title-3 font-semibold text-text">Sessions</h3>
        <ul className="flex flex-col divide-y divide-border">
          {h.sessions.slice(0, 12).map((s) => {
            const sum = s.summary
            const t = sum ? sum.focusedMinutes + sum.offTaskMinutes : 0
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setOpen(s.id)}
                  className="-mx-3 grid w-[calc(100%+24px)] grid-cols-[150px_1fr_80px] items-center gap-4 rounded-sm px-3 py-3 text-left outline-none transition-colors duration-fast hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
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
                      {clock(s.startedAt)} · {s.durationMs ? dur(s.durationMs / 1000) : '—'}
                    </span>
                  </span>
                  <span className="truncate text-small text-text-muted">{sum?.message ?? ''}</span>
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
