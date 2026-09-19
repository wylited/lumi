import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardBody, Stat } from '@heli/ui'
import { Distractions } from '@/components/analytics/Distractions'
import { Heatmap } from '@/components/analytics/Heatmap'
import { RecentSessions } from '@/components/analytics/RecentSessions'
import { SilenceBar } from '@/components/analytics/SilenceBar'
import { TierTable } from '@/components/analytics/TierTable'
import { mostEffective, tierEffects } from '@/components/analytics/derive'
import { Page, PageHeader, Section } from '@/components/shell/Page'
import { api } from '@/lib/api'
import { duration, minutes, percent } from '@/lib/format'
import { TIER_NAMES, type TierLevel } from '@heli/ui'

export const metadata: Metadata = { title: 'Overview' }

const VERB: Record<number, string> = {
  1: 'A change in the tray',
  2: 'A nudge',
  3: 'A spoken line',
  4: 'An automatic change',
}

export default async function Overview() {
  const [summary, tiers, apps, heatmap, sessions] = await Promise.all([
    api.analytics.summary(),
    api.analytics.tiers(),
    api.analytics.apps(),
    api.analytics.heatmap(),
    api.sessions(),
  ])

  const effects = tierEffects(tiers)
  const best = mostEffective(effects)
  const total = summary.focusedMinutes + summary.offTaskMinutes
  const focusShare = total ? summary.focusedMinutes / total : 0
  const finished = sessions.filter((s) => s.endedAt)

  return (
    <Page>
      <PageHeader
        eyebrow={`${finished.length} sessions`}
        title={
          best ? (
            <>
              {VERB[best.tier] ?? `Tier ${best.tier}`} gets you back{' '}
              <span className="text-accent-link">{percent(best.rate ?? 0)}</span> of the time.
            </>
          ) : (
            'Not enough interventions yet to say what works.'
          )
        }
        lede={`You were on the goal for ${percent(focusShare)} of tracked time. The system stayed quiet for most of it — that is the point.`}
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
        {[
          {
            label: 'Focused',
            value: minutes(summary.focusedMinutes),
            unit: summary.focusedMinutes >= 60 ? '' : 'min',
            hint: `${percent(focusShare)} of tracked time`,
          },
          {
            label: 'Off task',
            value: minutes(summary.offTaskMinutes),
            unit: summary.offTaskMinutes >= 60 ? '' : 'min',
            hint: `${apps.filter((a) => !a.onTask).length} distinct pulls`,
          },
          {
            label: 'Longest run',
            value: duration(summary.longestFocusRunSeconds),
            hint: 'unbroken, on the goal',
          },
          {
            label: 'Interventions',
            value: String(summary.interventions),
            hint: best ? `${TIER_NAMES[best.tier as TierLevel]} works best` : 'none judged yet',
          },
        ].map((s) => (
          <div key={s.label} className="bg-bg p-6">
            <Stat label={s.label} value={s.value} unit={s.unit} hint={s.hint} size="lg" />
          </div>
        ))}
      </div>

      <div className="mt-6">
        <SilenceBar histogram={summary.tierHistogram} />
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[1.6fr_1fr]">
        <Section title="What gets you back" aside="resolved within 2 min, by tier">
          <Card>
            <CardBody>
              <TierTable effects={effects} best={best} />
            </CardBody>
          </Card>
        </Section>
        <Section title="What pulls you away" aside="time off task">
          <Card>
            <CardBody>
              <Distractions rows={apps} />
            </CardBody>
          </Card>
        </Section>
      </div>

      <Section title="Focus by hour" aside="share of each hour on the goal" className="mt-14">
        <Card>
          <CardBody>
            <Heatmap rows={heatmap} />
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Recent sessions"
        aside={
          <Link href="/sessions" className="text-accent-link hover:underline">
            All sessions
          </Link>
        }
        className="mt-14"
      >
        <RecentSessions sessions={finished.slice(0, 6)} />
      </Section>
    </Page>
  )
}
