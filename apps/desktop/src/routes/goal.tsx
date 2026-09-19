import { useEffect, useMemo, useState } from 'react'
import type { Automation, Goal, GoalKind } from '@heli/contracts'
import { Button, useToast } from '@heli/ui'
import { Segmented, Stepper, Switch, Tokens } from '../components/goal/Controls'
import { Group, PageTitle, Row } from '../components/kit'
import {
  blankGoal,
  draft,
  loadGoal,
  saveGoal,
  toForm,
  type Draft,
  type GoalForm,
} from '../lib/goals'
import { logger } from '../lib/log'

const log = logger('goal')

const AUTOMATIONS: Array<{ value: Automation; label: string }> = [
  { value: 'mute_site', label: 'Mute an off-goal site' },
  { value: 'pause_notifications', label: 'Pause notifications' },
  { value: 'start_break', label: 'Start the break' },
  { value: 'open_app', label: 'Reopen the work app' },
]

const BREAKS = {
  none: 'None',
  pomodoro_25_5: '25 / 5',
  pomodoro_50_10: '50 / 10',
  custom: 'Custom',
} as const

/** The fields a draft would change, as label → new value, for the suggestion panel. */
function changes(form: GoalForm, d: Draft): Array<[string, string]> {
  const p = d.patch
  const out: Array<[string, string]> = []
  const list = (v?: string[]) => (v?.length ? v.join(', ') : 'none')
  if (p.objective && p.objective !== form.objective) out.push(['Goal', p.objective])
  if (p.successCriteria && p.successCriteria !== form.successCriteria)
    out.push(['Done when', p.successCriteria])
  if (p.kind && p.kind !== form.kind) out.push(['Kind', p.kind])
  if (p.timeBudgetMinutes && p.timeBudgetMinutes !== form.timeBudgetMinutes)
    out.push(['Time', `${p.timeBudgetMinutes} min`])
  if (p.breakPolicy && p.breakPolicy !== form.breakPolicy)
    out.push(['Breaks', BREAKS[p.breakPolicy]])
  if (p.allowedApps || p.allowedSites)
    out.push(['On the goal', list([...(p.allowedApps ?? []), ...(p.allowedSites ?? [])])])
  if (p.blockedApps || p.blockedSites)
    out.push(['Off the goal', list([...(p.blockedApps ?? []), ...(p.blockedSites ?? [])])])
  return out
}

export function GoalRoute() {
  const { toast } = useToast()
  const [saved, setSaved] = useState<Goal | null>(null)
  const [form, setForm] = useState<GoalForm>(blankGoal)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sentence, setSentence] = useState('')
  const [suggestion, setSuggestion] = useState<Draft | null>(null)

  useEffect(() => {
    loadGoal()
      .then((g) => {
        if (g) {
          setSaved(g)
          setForm(toForm(g))
        }
      })
      .catch((e: unknown) => log.error('could not load the goal', e))
      .finally(() => setLoading(false))
  }, [])

  const dirty = useMemo(
    () => !saved || JSON.stringify(toForm(saved)) !== JSON.stringify(form),
    [saved, form],
  )
  const set = <K extends keyof GoalForm>(k: K, v: GoalForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const may = (p: 'nudge' | 'speak' | 'automate') => form.permissions.includes(p)
  const allow = (p: 'nudge' | 'speak' | 'automate', on: boolean) =>
    set(
      'permissions',
      on ? [...new Set([...form.permissions, p])] : form.permissions.filter((x) => x !== p),
    )

  async function save() {
    setSaving(true)
    try {
      const g = await saveGoal(saved?.id ?? null, form)
      setSaved(g)
      setForm(toForm(g))
      toast('Saved', 'success')
    } catch (e) {
      log.error('save failed', e)
      toast('Could not save the goal', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null
  const p = form.policy
  const diff = suggestion ? changes(form, suggestion) : []

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-8 px-10 pb-16 pt-2">
      <PageTitle
        aside={
          <div className="flex items-center gap-2">
            {saved && dirty ? (
              <Button variant="ghost" size="sm" onClick={() => setForm(toForm(saved))}>
                Revert
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={save}
              loading={saving}
              disabled={!dirty || !form.objective.trim()}
            >
              {saved ? 'Save' : 'Create'}
            </Button>
          </div>
        }
      >
        Goal
      </PageTitle>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const d = draft(sentence)
          setSuggestion(d.notes.length ? d : null)
        }}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 focus-within:border-border-strong"
      >
        <input
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          placeholder="Describe it in a sentence — “finish the problem set by 9”"
          aria-label="Describe the goal in a sentence"
          className="min-w-0 flex-1 bg-transparent py-1 text-body text-text outline-none placeholder:text-text-faint"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!sentence.trim()}>
          Draft
        </Button>
      </form>

      {suggestion && diff.length ? (
        <Group
          title="Suggested changes"
          footer={
            <span className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => {
                  setForm((f) => ({ ...f, ...suggestion.patch }))
                  setSuggestion(null)
                }}
              >
                Apply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                Dismiss
              </Button>
            </span>
          }
        >
          {diff.map(([k, v]) => (
            <Row key={k} label={<span className="text-text-muted">{k}</span>}>
              <span className="max-w-[380px] truncate text-right text-body text-text">{v}</span>
            </Row>
          ))}
        </Group>
      ) : null}

      <div className="flex flex-col gap-1">
        <textarea
          value={form.objective}
          maxLength={280}
          rows={Math.max(1, Math.ceil(form.objective.length / 46))}
          onChange={(e) => set('objective', e.target.value.replace(/\n/g, ' '))}
          placeholder="What are you here to do?"
          aria-label="Objective"
          className="resize-none bg-transparent text-title-2 font-semibold text-text outline-none placeholder:text-text-faint"
        />
        <input
          value={form.successCriteria ?? ''}
          maxLength={280}
          onChange={(e) => set('successCriteria', e.target.value || null)}
          placeholder="Done when…"
          aria-label="Done when"
          className="bg-transparent text-body text-text-muted outline-none placeholder:text-text-faint"
        />
      </div>

      <Group title="Session">
        <Row label="Kind">
          <Segmented<GoalKind>
            label="Kind"
            value={form.kind}
            onChange={(v) => set('kind', v)}
            options={[
              { value: 'study', label: 'Study' },
              { value: 'work', label: 'Work' },
              { value: 'life', label: 'Life' },
            ]}
          />
        </Row>
        <Row label="Time">
          <Stepper
            label="time budget"
            unit="min"
            value={form.timeBudgetMinutes ?? 0}
            onChange={(v) => set('timeBudgetMinutes', v || null)}
          />
        </Row>
        <Row label="Breaks">
          <Segmented
            label="Breaks"
            value={form.breakPolicy === 'custom' ? 'none' : form.breakPolicy}
            onChange={(v) => set('breakPolicy', v)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'pomodoro_25_5', label: '25 / 5' },
              { value: 'pomodoro_50_10', label: '50 / 10' },
            ]}
          />
        </Row>
      </Group>

      <Group title="On the goal">
        <Row label="Apps" wide align="start">
          <Tokens
            label="Add an app on the goal"
            values={form.allowedApps}
            onChange={(v) => set('allowedApps', v)}
            placeholder="Add app"
          />
        </Row>
        <Row label="Sites" wide align="start">
          <Tokens
            label="Add a site on the goal"
            values={form.allowedSites}
            onChange={(v) => set('allowedSites', v)}
            placeholder="Add site"
          />
        </Row>
      </Group>

      <Group title="Off the goal">
        <Row label="Apps" wide align="start">
          <Tokens
            label="Add an off-goal app"
            values={form.blockedApps}
            onChange={(v) => set('blockedApps', v)}
            placeholder="Add app"
          />
        </Row>
        <Row label="Sites" wide align="start">
          <Tokens
            label="Add an off-goal site"
            values={form.blockedSites}
            onChange={(v) => set('blockedSites', v)}
            placeholder="Add site"
          />
        </Row>
      </Group>

      <Group
        title="It may"
        footer={`Silent by default. It acts only after ${p.driftSeconds} s off the goal, and only when it is at least ${Math.round(p.minConfidence * 100)}% sure.`}
      >
        <Row
          label="Nudge"
          detail={
            may('speak')
              ? 'Only when speaking is off: it speaks first'
              : `A notification, at most every ${Math.round(p.nudgeGapMs / 60_000)} min`
          }
        >
          <Switch label="Nudge" checked={may('nudge')} onChange={(v) => allow('nudge', v)} />
        </Row>
        <Row
          label="Speak"
          detail={`First, when you drift: one sentence out loud, at most every ${Math.round(p.minGapMs / 1000)} s`}
        >
          <Switch label="Speak" checked={may('speak')} onChange={(v) => allow('speak', v)} />
        </Row>
        <Row
          label="Change my machine"
          detail="Hides blocked apps and moves tabs off blocked sites. Undo in one click."
        >
          <Switch
            label="Change my machine"
            checked={may('automate')}
            onChange={(v) => allow('automate', v)}
          />
        </Row>
        {may('automate')
          ? AUTOMATIONS.map((a) => (
              <Row key={a.value} label={<span className="pl-4 text-text-muted">{a.label}</span>}>
                <Switch
                  label={a.label}
                  checked={form.automations.includes(a.value)}
                  onChange={(on) =>
                    set(
                      'automations',
                      on
                        ? [...form.automations, a.value]
                        : form.automations.filter((x) => x !== a.value),
                    )
                  }
                />
              </Row>
            ))
          : null}
      </Group>
    </div>
  )
}
