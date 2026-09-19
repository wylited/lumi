/**
 * Goals: load, save, and turn a sentence into a draft.
 *
 * The draft is a suggestion the user accepts or discards — it never overwrites a field on its own.
 * It is parsed locally for now: there is no server route that drafts a goal, and a client must
 * never hold a model key. When the server grows `POST /v1/goals/draft`, `draft()` calls it and
 * keeps this as the offline fallback.
 */
import { DEFAULT_POLICY, Goal, type GoalCreateRequest, type GoalKind } from '@heli/contracts'
import { api } from './api'

export type GoalForm = Omit<GoalCreateRequest, 'policy'> & { policy: Goal['policy'] }

export function blankGoal(): GoalForm {
  return {
    kind: 'study',
    objective: '',
    successCriteria: null,
    timeBudgetMinutes: 50,
    breakPolicy: 'pomodoro_25_5',
    allowedApps: [],
    blockedApps: [],
    allowedSites: [],
    blockedSites: [],
    permissions: ['nudge', 'speak'],
    automations: [],
    policy: DEFAULT_POLICY,
    active: true,
  }
}

const FormSchema = Goal.omit({ id: true, createdAt: true })

export function toForm(g: Goal): GoalForm {
  return FormSchema.parse(g)
}

export async function loadGoal(): Promise<Goal | null> {
  const goals = await api.goals()
  return goals.find((g) => g.active) ?? goals[0] ?? null
}

export async function saveGoal(id: string | null, form: GoalForm): Promise<Goal> {
  // Speaking needs tier 3 and automating tier 4; the policy's ceiling follows the permissions.
  const maxTier = form.permissions.includes('automate')
    ? 4
    : form.permissions.includes('speak')
      ? 3
      : form.permissions.includes('nudge')
        ? 2
        : 1
  const body = { ...form, policy: { ...form.policy, maxTier } }
  return id ? api.updateGoal(id, body) : api.createGoal(body)
}

/* ---- the sentence → draft ------------------------------------------------ */

export interface Draft {
  patch: Partial<GoalForm>
  /** One line per inference, so the user sees why each field was suggested. */
  notes: string[]
}

const KIND_WORDS: Record<GoalKind, RegExp> = {
  study:
    /\b(study|problem set|pset|homework|exam|revise|revision|essay|lecture|chapter|reading|assignment|thesis|flashcards?|algorithms?|calculus|algebra)\b/i,
  work: /\b(pr|pull request|report|deck|slides|email|inbox|ship|deploy|review|spec|proposal|invoice|client|ticket|bug|feature)\b/i,
  life: /\b(taxes|budget|clean|gym|run|cook|meal|apartment|garden|call|bills?|journal|practice|guitar|piano)\b/i,
}

const APPS: Array<[RegExp, string[]]> = [
  [
    /\b(code|coding|program|algorithms?|bug|pr|pull request|feature|deploy|ship)\b/i,
    ['Code', 'Terminal'],
  ],
  [/\b(essay|write|writing|report|thesis|journal|notes?)\b/i, ['Notes', 'Pages']],
  [/\b(deck|slides|presentation)\b/i, ['Keynote']],
  [/\b(read|reading|paper|chapter|pdf)\b/i, ['Preview']],
  [/\b(taxes|budget|invoice|bills?|spreadsheet)\b/i, ['Numbers']],
  [/\b(math|algebra|calculus|problem set|pset)\b/i, ['Notes', 'Preview', 'Calculator']],
]

const SITES: Array<[RegExp, string[]]> = [
  [/\b(algebra|calculus|math|problem set|pset)\b/i, ['khanacademy.org', 'ocw.mit.edu']],
  [
    /\b(code|coding|algorithms?|bug|pr|deploy)\b/i,
    ['github.com', 'developer.mozilla.org', 'stackoverflow.com'],
  ],
  [/\b(essay|thesis|paper|research)\b/i, ['scholar.google.com']],
]

const ALWAYS_BLOCKED_SITES = ['youtube.com', 'x.com', 'reddit.com', 'instagram.com', 'tiktok.com']
const BLOCKED_APPS_BY_KIND: Record<GoalKind, string[]> = {
  study: ['Discord', 'Slack', 'Steam', 'Messages'],
  work: ['Discord', 'Steam'],
  life: ['Steam'],
}

function budgetFrom(text: string, now: Date): { minutes: number; note: string } | null {
  const dur = text.match(
    /\bfor\s+(?:an?\s+)?(\d+(?:\.\d+)?)?\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i,
  )
  if (dur) {
    const n = dur[1] ? parseFloat(dur[1]) : 1
    const minutes = Math.round(/^h/i.test(dur[2]!) ? n * 60 : n)
    return { minutes, note: `Time budget: ${minutes} min, from “${dur[0].trim()}”.` }
  }
  const by = text.match(/\b(?:by|until|before|till)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (by) {
    let h = parseInt(by[1]!, 10)
    const m = by[2] ? parseInt(by[2], 10) : 0
    const mer = by[3]?.toLowerCase()
    if (mer === 'pm' && h < 12) h += 12
    if (mer === 'am' && h === 12) h = 0
    const target = new Date(now)
    target.setHours(h, m, 0, 0)
    // "by 9" at 14:00 means 21:00, not tomorrow morning.
    if (!mer && target <= now && h < 12) target.setHours(h + 12)
    if (target <= now) target.setDate(target.getDate() + 1)
    const minutes = Math.round((target.getTime() - now.getTime()) / 60_000)
    if (minutes < 5 || minutes > 16 * 60) return null
    const hhmm = target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    return { minutes, note: `Time budget: ${minutes} min, until ${hhmm}.` }
  }
  return null
}

export function draft(sentence: string, now = new Date()): Draft {
  const text = sentence.trim()
  const notes: string[] = []
  const patch: Partial<GoalForm> = {}
  if (!text) return { patch, notes }

  const kind =
    (Object.keys(KIND_WORDS) as GoalKind[]).find((k) => KIND_WORDS[k].test(text)) ?? 'work'
  patch.kind = kind
  notes.push(`Kind: ${kind}.`)

  const objective = text
    .replace(/\s*\b(?:by|until|before|till)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '')
    .replace(/\s*\bfor\s+(?:an?\s+)?\d*(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b/i, '')
    .replace(/^(i\s+(?:want|need|have)\s+to|i'?m\s+going\s+to|let'?s|gonna)\s+/i, '')
    // A count said as an aside (", 8 problems,") becomes the success criterion, not objective text.
    .replace(
      /,\s*\d+\s+(?:problems?|questions?|pages?|exercises?|chapters?|tickets?|emails?)\s*(?=,|$)/i,
      '',
    )
    .replace(/[\s,;:.!]+$/, '')
    .replace(/\s*,\s*,/g, ',')
  patch.objective = objective.charAt(0).toUpperCase() + objective.slice(1)

  const budget = budgetFrom(text, now)
  if (budget) {
    patch.timeBudgetMinutes = budget.minutes
    notes.push(budget.note)
    patch.breakPolicy =
      budget.minutes > 100 ? 'pomodoro_50_10' : budget.minutes > 35 ? 'pomodoro_25_5' : 'none'
    notes.push(
      patch.breakPolicy === 'none'
        ? 'Breaks: none — it is short.'
        : `Breaks: ${patch.breakPolicy === 'pomodoro_50_10' ? '50 on, 10 off' : '25 on, 5 off'}.`,
    )
  }

  const count = text.match(
    /\b(\d+)\s+(problems?|questions?|pages?|exercises?|chapters?|tickets?|emails?)\b/i,
  )
  if (count) {
    patch.successCriteria = `All ${count[1]} ${count[2]!.toLowerCase()} done`
    notes.push(`Done when: all ${count[1]} ${count[2]!.toLowerCase()}.`)
  }

  const apps = [...new Set(APPS.flatMap(([re, a]) => (re.test(text) ? a : [])))]
  const sites = [...new Set(SITES.flatMap(([re, s]) => (re.test(text) ? s : [])))]
  patch.allowedApps = apps.length ? ['Safari', ...apps] : ['Safari']
  patch.allowedSites = sites
  patch.blockedApps = BLOCKED_APPS_BY_KIND[kind]
  patch.blockedSites = ALWAYS_BLOCKED_SITES
  notes.push(
    `Allowed: ${patch.allowedApps.join(', ')}${sites.length ? `, ${sites.join(', ')}` : ''}.`,
  )
  notes.push('Blocked: the usual feeds and chat. Edit any of it.')

  return { patch, notes }
}
