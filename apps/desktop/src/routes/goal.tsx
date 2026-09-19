import { useEffect, useMemo, useState } from 'react'
import type { Automation, Goal, GoalKind } from '@heli/contracts'
import { Button, useToast } from '@heli/ui'
import { Assistant } from '../components/goal/Assistant'
import { Consequences } from '../components/goal/Consequences'
import { Field, Segmented, Toggle, Tokens } from '../components/goal/Controls'
import { blankGoal, loadGoal, saveGoal, toForm, type GoalForm } from '../lib/goals'
import { logger } from '../lib/log'

const log = logger('goal')

const AUTOMATIONS: Array<{ value: Automation; label: string }> = [
  { value: 'mute_site', label: 'Mute a blocked site' },
  { value: 'pause_notifications', label: 'Pause notifications' },
  { value: 'start_break', label: 'Start the break' },
  { value: 'open_app', label: 'Reopen the work app' },
]

export function GoalRoute() {
  const { toast } = useToast()
  const [saved, setSaved] = useState<Goal | null>(null)
  const [form, setForm] = useState<GoalForm>(blankGoal)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

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
      toast('Goal saved.', 'success')
    } catch (e) {
      log.error('save failed', e)
      toast('Could not save the goal.', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-10 px-8 py-8 pb-28">
      <Assistant
        onAccept={(d) => {
          setForm((f) => ({ ...f, ...d.patch }))
        }}
      />

      <div className="grid gap-10 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-8">
          <Field label="Objective" hint={`${form.objective.length} / 280`}>
            <textarea
              value={form.objective}
              maxLength={280}
              rows={2}
              onChange={(e) => set('objective', e.target.value)}
              placeholder="Finish the linear algebra problem set"
              className="resize-none rounded-md border border-border-strong bg-bg px-4 py-3 text-title-3 font-semibold text-text outline-none placeholder:font-normal placeholder:text-text-faint focus:border-accent focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg"
            />
          </Field>
          <Field label="Done when" hint="optional">
            <input
              value={form.successCriteria ?? ''}
              maxLength={280}
              onChange={(e) => set('successCriteria', e.target.value || null)}
              placeholder="All 12 problems attempted, with working written up"
              className="h-10 rounded-pill border border-border-strong bg-bg px-4 text-body text-text outline-none placeholder:text-text-faint focus:border-accent focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-bg"
            />
          </Field>

          <div className="grid gap-8 sm:grid-cols-2">
            <Field label="Kind">
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
            </Field>
            <Field
              label="Time budget"
              hint={form.timeBudgetMinutes ? `${form.timeBudgetMinutes} min` : 'open-ended'}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={480}
                  step={5}
                  value={form.timeBudgetMinutes ?? 0}
                  onChange={(e) => set('timeBudgetMinutes', Number(e.target.value) || null)}
                  aria-label="Time budget in minutes"
                  className="w-full accent-[var(--accent)]"
                />
              </div>
            </Field>
          </div>

          <Field label="Breaks">
            <Segmented
              label="Breaks"
              value={form.breakPolicy === 'custom' ? 'none' : form.breakPolicy}
              onChange={(v) => set('breakPolicy', v)}
              options={[
                { value: 'none', label: 'None' },
                { value: 'pomodoro_25_5', label: '25 on · 5 off' },
                { value: 'pomodoro_50_10', label: '50 on · 10 off' },
              ]}
            />
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="On the goal" hint="apps">
              <Tokens
                tone="allow"
                values={form.allowedApps}
                onChange={(v) => set('allowedApps', v)}
                placeholder="Code, Notes…"
              />
            </Field>
            <Field label="Off the goal" hint="apps">
              <Tokens
                tone="block"
                values={form.blockedApps}
                onChange={(v) => set('blockedApps', v)}
                placeholder="Discord, Steam…"
              />
            </Field>
            <Field label="On the goal" hint="sites">
              <Tokens
                tone="allow"
                values={form.allowedSites}
                onChange={(v) => set('allowedSites', v)}
                placeholder="github.com…"
              />
            </Field>
            <Field label="Off the goal" hint="sites">
              <Tokens
                tone="block"
                values={form.blockedSites}
                onChange={(v) => set('blockedSites', v)}
                placeholder="youtube.com…"
              />
            </Field>
          </div>

          <Field label="It may">
            <div className="grid gap-2 sm:grid-cols-3">
              <Toggle
                checked={may('nudge')}
                onChange={(v) => allow('nudge', v)}
                label="Nudge"
                detail="A notification with an action"
              />
              <Toggle
                checked={may('speak')}
                onChange={(v) => allow('speak', v)}
                label="Speak"
                detail="One sentence, out loud"
              />
              <Toggle
                checked={may('automate')}
                onChange={(v) => allow('automate', v)}
                label="Automate"
                detail="Reversible changes"
              />
            </div>
          </Field>

          {may('automate') ? (
            <Field label="Which changes" hint="each is shown and undoable">
              <div className="flex flex-wrap gap-2">
                {AUTOMATIONS.map((a) => {
                  const on = form.automations.includes(a.value)
                  return (
                    <button
                      key={a.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set(
                          'automations',
                          on
                            ? form.automations.filter((x) => x !== a.value)
                            : [...form.automations, a.value],
                        )
                      }
                      className={`rounded-pill border px-3.5 py-1.5 text-small transition-colors duration-fast ${on ? 'border-accent bg-accent-wash text-accent-link' : 'border-border text-text-muted hover:border-border-strong'}`}
                    >
                      {a.label}
                    </button>
                  )
                })}
              </div>
            </Field>
          ) : null}
        </div>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <Consequences form={form} />
        </aside>
      </div>

      <div className="fixed bottom-0 left-[232px] right-0 z-10 border-t border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1040px] items-center justify-end gap-3 px-8 py-3.5">
          <span className="mr-auto text-caption text-text-faint">
            {dirty ? (saved ? 'Unsaved changes' : 'Not saved yet') : 'Saved'}
          </span>
          {saved && dirty ? (
            <Button variant="ghost" onClick={() => setForm(toForm(saved))}>
              Revert
            </Button>
          ) : null}
          <Button onClick={save} loading={saving} disabled={!dirty || !form.objective.trim()}>
            {saved ? 'Save goal' : 'Create goal'}
          </Button>
        </div>
      </div>
    </div>
  )
}
