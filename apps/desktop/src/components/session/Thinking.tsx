import type { Observation } from '@heli/contracts'
import { cn } from '@heli/ui'
import { Dot } from '../kit'
import { dur, mm } from './format'

/** How cluttered, in one word a person would use. */
function word(score: number): 'clear' | 'busy' | 'cluttered' {
  return score < 0.3 ? 'clear' : score < 0.6 ? 'busy' : 'cluttered'
}

/** The tier and its reason in one sentence — what it decided, and why, in words. */
function decision(o: Observation): string {
  if (o.survey) return `read the desk — ${word(o.survey.score)}`
  const drift = o.assessment ? dur(o.assessment.driftSeconds) : ''
  switch (o.tier) {
    case 0:
      return o.assessment?.onTask === false
        ? `quiet — ${drift} off, not enough to interrupt`
        : 'quiet — nothing to interrupt'
    case 1:
      return `the light — ${drift} off the goal`
    case 2:
      return `nudged — ${drift} off the goal`
    case 3:
      return 'spoke — the nudge was ignored'
    case 4:
      return 'pointed at the page'
    default:
      return 'summarised the session'
  }
}

/** The newest reading, as a person would say it. */
export function Thinking({
  latest,
  latestSurvey,
  since,
  frames,
  interruptions,
}: {
  latest: Observation | null
  latestSurvey: Observation | null
  since: string | null
  frames: number
  interruptions: number
}) {
  const a = latest?.assessment ?? null
  // The reading travels on a row of its own, so it carries the moment it was taken.
  const reading = latestSurvey?.survey ? { ...latestSurvey.survey, at: latestSurvey.ts } : null
  const worst = reading?.hotspots[0] ?? null
  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-border p-5"
      aria-label="What it is thinking"
    >
      <span className="text-small font-medium text-text-muted">What it is thinking</span>
      {!latest || !a ? (
        <p className="text-body text-text-faint">The first reading lands within a minute.</p>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <Dot tone={a.onTask || a.activity === 'break' ? 'focus' : 'drift'} />
            <span className="text-title-3 font-semibold text-text">
              {a.activity === 'break' ? 'On a break' : a.onTask ? 'On the goal' : 'Off the goal'}
            </span>
            <span className="text-body text-text-faint">{a.activity}</span>
          </div>
          <ul className="flex flex-col gap-1">
            {a.evidence.slice(0, 3).map((e) => (
              <li key={e} className="text-small text-text-muted">
                {e}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <span
              className="h-1 flex-1 overflow-hidden rounded-pill bg-ink-100"
              role="meter"
              aria-label="Confidence"
              aria-valuenow={Math.round(a.confidence * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className={cn(
                  'block h-full rounded-pill',
                  a.confidence >= 0.7 ? 'bg-text' : 'bg-ink-300',
                )}
                style={{ width: `${a.confidence * 100}%` }}
              />
            </span>
            <span className="tnum text-caption text-text-faint">
              {Math.round(a.confidence * 100)}% sure
            </span>
          </div>
          <p className="border-t border-border pt-3 text-body text-text">{decision(latest)}</p>
        </>
      )}
      {reading ? (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <span className="text-body text-text">
            The desk looks {word(reading.score)} — {reading.score.toFixed(2)}
          </span>
          {worst ? <span className="text-small text-text-muted">Mostly {worst.label}.</span> : null}
          <ul className="flex flex-col gap-1">
            {reading.evidence.slice(0, 3).map((e) => (
              <li key={e} className="text-small text-text-muted">
                {e}
              </li>
            ))}
          </ul>
          <span className="tnum text-caption text-text-faint">
            swept {mm(Math.max(0, (Date.now() - Date.parse(reading.at)) / 1000))} ago
          </span>
        </div>
      ) : null}
      <p className="tnum text-caption text-text-faint">
        {since
          ? `watched since ${new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
          : 'not watching'}
        {` · ${frames} ${frames === 1 ? 'frame' : 'frames'} read · ${interruptions} ${interruptions === 1 ? 'interruption' : 'interruptions'}`}
      </p>
    </section>
  )
}
