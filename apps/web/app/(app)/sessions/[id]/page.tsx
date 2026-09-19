import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Card, CardBody, KeyValue, Stat, TierBadge } from '@heli/ui'
import { Replay } from '@/components/session/Replay'
import { Strip, StripLegend } from '@/components/session/Strip'
import { Page } from '@/components/shell/Page'
import { api } from '@/lib/api'
import { clock, day, duration, minutes, percent } from '@/lib/format'

export const metadata: Metadata = { title: 'Session' }

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const s = await api.session(id)
  if (!s) notFound()

  const sum = s.summary
  const tracked = sum ? sum.focusedMinutes + sum.offTaskMinutes : 0
  const goal = s.goal
  const loud = s.observations.filter((o) => o.tier > 0)
  const off = new Map<string, number>()
  for (const o of s.observations) {
    if (o.assessment && !o.assessment.onTask) {
      const key =
        o.signals.topSites[0]?.title ??
        (o.assessment.kind === 'phone' ? 'Phone' : (o.signals.topApps[0]?.app ?? 'Unknown'))
      off.set(key, (off.get(key) ?? 0) + o.signals.offTaskSeconds)
    }
  }

  return (
    <Page>
      <Link href="/sessions" className="text-small text-text-faint hover:text-text">
        ← Sessions
      </Link>
      <div className="mb-10 mt-5 flex flex-col gap-2">
        <span className="tnum text-label uppercase text-text-faint">
          {day(s.startedAt)} · {clock(s.startedAt)}–{s.endedAt ? clock(s.endedAt) : 'now'}
        </span>
        <h1 className="text-display-2 font-semibold text-balance text-text">
          {goal?.objective ?? 'Untitled session'}
        </h1>
        {sum?.message ? <p className="measure text-body text-text-muted">{sum.message}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
        <Cell>
          <Stat
            label="On the goal"
            value={tracked ? percent(sum!.focusedMinutes / tracked) : '—'}
            hint={sum ? `${minutes(sum.focusedMinutes)} min focused` : undefined}
          />
        </Cell>
        <Cell>
          <Stat
            label="Off task"
            value={sum ? minutes(sum.offTaskMinutes) : '—'}
            unit="min"
            hint={sum?.topDistraction ? `mostly ${sum.topDistraction}` : 'nothing stood out'}
          />
        </Cell>
        <Cell>
          <Stat
            label="Longest run"
            value={sum ? duration(sum.longestFocusRunSeconds) : '—'}
            hint="unbroken"
          />
        </Cell>
        <Cell>
          <Stat
            label="Windows"
            value={String(s.observations.length)}
            hint={`${s.observations.length - loud.length} silent · ${loud.length} acted`}
          />
        </Cell>
      </div>

      <div className="mt-8 flex flex-col gap-3">
        <Strip observations={s.observations} linkPrefix="" />
        <div className="flex items-center justify-between">
          <span className="tnum font-mono text-[11px] text-text-faint">{clock(s.startedAt)}</span>
          <StripLegend />
          <span className="tnum font-mono text-[11px] text-text-faint">
            {s.endedAt ? clock(s.endedAt) : 'now'}
          </span>
        </div>
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[1fr_300px]">
        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="text-title-3 font-semibold text-text">The session, as it happened</h2>
          <Replay observations={s.observations} />
        </section>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          {goal ? (
            <Card>
              <CardBody className="flex flex-col gap-4">
                <span className="text-label uppercase text-text-faint">The rules it ran under</span>
                <KeyValue
                  items={[
                    {
                      key: 'Time budget',
                      value: goal.timeBudgetMinutes ? `${goal.timeBudgetMinutes} min` : 'none',
                    },
                    {
                      key: 'Breaks',
                      value: goal.breakPolicy.replace('pomodoro_', '').replace('_', ' / '),
                    },
                    { key: 'May', value: goal.permissions.join(', ') || 'only watch' },
                    {
                      key: 'Highest tier',
                      value: <TierBadge tier={goal.policy.maxTier} compact />,
                    },
                    { key: 'Drift before acting', value: `${goal.policy.driftSeconds}s` },
                    { key: 'Min confidence', value: goal.policy.minConfidence.toFixed(2) },
                    { key: 'Nudge gap', value: duration(goal.policy.nudgeGapMs / 1000) },
                  ]}
                />
              </CardBody>
            </Card>
          ) : null}
          {off.size ? (
            <Card>
              <CardBody className="flex flex-col gap-4">
                <span className="text-label uppercase text-text-faint">Pulled away by</span>
                <KeyValue
                  items={[...off.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => ({ key: k, value: duration(v) }))}
                />
              </CardBody>
            </Card>
          ) : null}
        </aside>
      </div>
    </Page>
  )
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div className="bg-bg p-6">{children}</div>
}
