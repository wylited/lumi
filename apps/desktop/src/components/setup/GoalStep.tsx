import { useState } from 'react'
import type { Goal, GoalDraft, GoalKind, Permission } from '@heli/contracts'
import { Button, cn } from '@heli/ui'
import { Segmented, Stepper, Tokens } from '../goal/Controls'
import { Group, Row } from '../kit'
import { draftGoal, saveDraft } from '../../lib/setup'

const KINDS: Array<{ value: GoalKind; label: string }> = [
  { value: 'study', label: 'Study' },
  { value: 'work', label: 'Work' },
  { value: 'life', label: 'Life' },
]

/** The escalation the person grants, shown as the ladder it is. */
const LADDER: Array<{ value: Permission; label: string; detail: string }> = [
  { value: 'nudge', label: 'Nudge', detail: 'a notification' },
  { value: 'speak', label: 'Speak', detail: 'one sentence, out loud' },
  { value: 'automate', label: 'Point at the page', detail: 'the arm, or a reversible change' },
]

export function GoalStep({
  existing,
  onDone,
}: {
  existing: Goal | null
  onDone: (goal: Goal) => void
}) {
  const [sentence, setSentence] = useState(existing?.objective ?? '')
  const [kind, setKind] = useState<GoalKind>('study')
  const [reading, setReading] = useState(false)
  const [draft, setDraft] = useState<GoalDraft | null>(null)
  const [fellBack, setFellBack] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function read() {
    setReading(true)
    setError(null)
    const { draft: d, fellBack: local } = await draftGoal(sentence)
    setDraft({ ...d, kind })
    setFellBack(local)
    setReading(false)
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      onDone(await saveDraft(draft, existing))
    } catch {
      setError('Could not save the goal to the server. Check it is running, then try again.')
    } finally {
      setSaving(false)
    }
  }

  const set = <K extends keyof GoalDraft>(k: K, v: GoalDraft[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  const has = (p: Permission) => draft?.permissions.includes(p) ?? false

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-display-2 font-semibold tracking-tight text-text">
          What are you here to do?
        </h1>
        <p className="text-body text-text-muted">
          Say it in one sentence. Lumi turns it into a goal you can edit.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void read()
        }}
        className="flex flex-col gap-3"
      >
        <textarea
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          rows={2}
          placeholder="Finish the problem set by 9, working written up"
          aria-label="Your goal, in a sentence"
          className="resize-none rounded-md border border-border-strong bg-bg px-4 py-3 text-title-3 text-text outline-none focus:border-text"
        />
        <div className="flex items-center justify-between gap-3">
          <Segmented label="Kind" value={kind} onChange={setKind} options={KINDS} />
          <Button type="submit" loading={reading} disabled={!sentence.trim()}>
            {draft ? 'Draft again' : 'Draft it'}
          </Button>
        </div>
      </form>

      {reading ? (
        <p className="text-body text-text-muted" role="status">
          Reading your sentence…
        </p>
      ) : null}

      {draft && !reading ? (
        <div className="flex flex-col gap-6">
          <p className="text-small text-text-faint" role="status">
            {fellBack
              ? 'Drafted on this Mac — the server’s model was not reachable. Edit anything.'
              : 'Drafted by the model. Edit anything.'}
          </p>
          <div className="flex flex-col gap-1">
            <input
              value={draft.objective}
              onChange={(e) => set('objective', e.target.value)}
              aria-label="Objective"
              className="bg-transparent text-title-2 font-semibold text-text outline-none"
            />
            <input
              value={draft.successCriteria ?? ''}
              onChange={(e) => set('successCriteria', e.target.value || null)}
              placeholder="Done when…"
              aria-label="Done when"
              className="bg-transparent text-body text-text-muted outline-none placeholder:text-text-faint"
            />
          </div>

          <Group>
            <Row label="Time">
              <Stepper
                label="time budget"
                unit="min"
                value={draft.timeBudgetMinutes ?? 0}
                onChange={(v) => set('timeBudgetMinutes', v || null)}
              />
            </Row>
            <Row label="Breaks">
              <Segmented
                label="Breaks"
                value={draft.breakPolicy === 'custom' ? 'none' : draft.breakPolicy}
                onChange={(v) => set('breakPolicy', v)}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'pomodoro_25_5', label: '25 / 5' },
                  { value: 'pomodoro_50_10', label: '50 / 10' },
                ]}
              />
            </Row>
            <Row label="On the goal" wide align="start">
              <Tokens
                label="Add an app or site on the goal"
                values={[...draft.allowedApps, ...draft.allowedSites]}
                placeholder="Add"
                onChange={(v) => {
                  set(
                    'allowedSites',
                    v.filter((x) => x.includes('.')),
                  )
                  set(
                    'allowedApps',
                    v.filter((x) => !x.includes('.')),
                  )
                }}
              />
            </Row>
            <Row label="Off the goal" wide align="start">
              <Tokens
                label="Add an app or site off the goal"
                values={[...draft.blockedApps, ...draft.blockedSites]}
                placeholder="Add"
                onChange={(v) => {
                  set(
                    'blockedSites',
                    v.filter((x) => x.includes('.')),
                  )
                  set(
                    'blockedApps',
                    v.filter((x) => !x.includes('.')),
                  )
                }}
              />
            </Row>
          </Group>

          <div className="flex flex-col gap-2">
            <span className="px-1 text-small font-medium text-text-muted">
              When you drift, it may
            </span>
            <ol className="flex flex-wrap items-center gap-2">
              {LADDER.map((step, i) => (
                <li key={step.value} className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={has(step.value)}
                    onClick={() =>
                      set(
                        'permissions',
                        has(step.value)
                          ? draft.permissions.filter((p) => p !== step.value)
                          : [...draft.permissions, step.value],
                      )
                    }
                    className={cn(
                      'flex flex-col items-start rounded-md border px-3.5 py-2 text-left outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent',
                      has(step.value)
                        ? 'border-accent bg-accent-wash'
                        : 'border-border text-text-faint hover:border-border-strong',
                    )}
                  >
                    <span
                      className={cn(
                        'text-small font-medium',
                        has(step.value) ? 'text-text' : 'text-text-faint',
                      )}
                    >
                      {step.label}
                    </span>
                    <span className="text-caption text-text-faint">{step.detail}</span>
                  </button>
                  {i < LADDER.length - 1 ? (
                    <span className="text-text-faint" aria-hidden="true">
                      →
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            <p className="px-1 text-caption text-text-faint">
              Each step happens only if the one before it did not work.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
          <div>
            <Button onClick={() => void save()} loading={saving} disabled={!draft.objective.trim()}>
              Use this goal
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
