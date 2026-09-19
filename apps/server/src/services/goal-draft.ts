import { readFileSync } from 'node:fs'

import { GoalDraft } from '@heli/contracts'
import type { GoalDraft as GoalDraftBody, GoalKind } from '@heli/contracts'

import { env } from '../env.js'
import { childLogger } from '../logger.js'

const log = childLogger({ module: 'goal-draft' })

/**
 * Drafting a goal from one sentence (HELI-072).
 *
 * Two paths, in this order:
 *
 *   1. **The model.** One text call to DeepSeek, JSON mode, the schema stated in
 *      `observe/prompts/goal.md`, zod as the judge — the same shape as the assess
 *      step (`observe/assess.ts` holds a provider's output to the frozen schema;
 *      `models/deepseek.ts` is the calling convention). `models/deepseek.ts` is
 *      frozen and exports no text call, so the call itself is composed here and
 *      reuses its conventions rather than adding a second one.
 *   2. **The local rules.** A plain parse of the sentence — a clock time, a
 *      duration, a deadline word, app and site names it recognises — so the path
 *      works with no key at all. This is also the fallback for *any* model
 *      failure, including a schema-invalid reply.
 *
 * A draft is a suggestion the person accepts or edits. Refusing to suggest is
 * worse than suggesting plainly, so nothing on this path throws: `draftGoal`
 * always answers with a `GoalDraft`, and its `source` says which path produced
 * it. The local rules are the reference for what to recognise — the desktop's
 * own `lib/goals.ts#draft`, which this route replaces.
 */

/* ---- the model path ------------------------------------------------------ */

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * What the model is asked for: `GoalDraft` minus the three fields the *server*
 * owns. `automations` and `active` are not suggestions (a draft never proposes a
 * machine action, and a goal is active when it is created), and `source` is the
 * report of which path answered, which the model cannot know. Deriving the
 * model's schema by omission rather than writing a second one down is what keeps
 * it from drifting away from the contract.
 */
const ModelDraft = GoalDraft.omit({ source: true, automations: true, active: true })

/** What the model is asked for, as a type — the same three fields taken out. */
type ModelDraftBody = Omit<GoalDraftBody, 'source' | 'automations' | 'active'>

/** Used only when `observe/prompts/goal.md` cannot be read, as in `deepseek.ts`. */
const FALLBACK_SYSTEM_PROMPT =
  'You turn one sentence into a goal draft. Return only JSON matching the GoalDraft schema: ' +
  'kind, objective, successCriteria, timeBudgetMinutes, breakPolicy, allowedApps, blockedApps, ' +
  'allowedSites, blockedSites, permissions. Never invent an app, a site or a deadline the ' +
  'sentence does not support, and never decide anything about the machine.'

let cachedSystemPrompt: string | null = null

/** The prompt is the schema's home: it states the shape the model must answer with. */
function systemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt
  try {
    cachedSystemPrompt = readFileSync(
      new URL('../observe/prompts/goal.md', import.meta.url),
      'utf8',
    )
  } catch (error) {
    log.warn({ err: error }, 'goal draft prompt unreadable; using the built-in one')
    cachedSystemPrompt = FALLBACK_SYSTEM_PROMPT
  }
  return cachedSystemPrompt
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

interface CallResult {
  ok: boolean
  status: number
  data: ChatCompletionResponse | null
  raw: string
}

/**
 * One call, one turn. The text is the only input, so there is no user message
 * body beyond the sentence and no second turn to spend.
 */
async function callDeepSeek(
  sentence: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<CallResult> {
  try {
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: sentence },
        ],
        temperature: 0,
        stream: false,
        // JSON mode only: this endpoint has no `json_schema` (see `deepseek.ts`),
        // so the schema travels in the prompt and zod judges the reply.
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    let data: ChatCompletionResponse | null = null
    try {
      data = JSON.parse(raw) as ChatCompletionResponse
    } catch {
      data = null
    }
    return { ok: response.ok, status: response.status, data, raw }
  } catch (error) {
    return { ok: false, status: 0, data: null, raw: error instanceof Error ? error.message : '' }
  }
}

function stripFences(content: string): string {
  const trimmed = content.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/**
 * Parse defensively — a model may wrap its JSON in prose or fences — and then
 * let zod decide. Anything that is not a complete `ModelDraft` is `null`, which
 * sends the caller to the local rules.
 */
export function parseDraftContent(content: unknown): ModelDraftBody | null {
  if (typeof content !== 'string' || content.trim().length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(content))
  } catch {
    return null
  }
  const parsed = ModelDraft.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The model's suggestion, or `null` when there is no key, the call fails, or the
 * reply is not schema-valid JSON. One retry covers a transient malformed reply,
 * exactly as the assess step does. Nothing here throws into the route.
 */
async function fromModel(sentence: string): Promise<GoalDraftBody | null> {
  // `DEEPSEEK_API_KEY=` in a `.env` is an empty string, not an absent key, and
  // an empty bearer token is not a key. `VISION_PROVIDER=local` on this box is
  // the same statement said the other way.
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    log.info('goal draft: no deepseek key, drafting with the local rules')
    return null
  }

  const started = Date.now()
  let lastFailure = 'unknown error'

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callDeepSeek(sentence, apiKey, env.DEEPSEEK_MODEL, DEFAULT_TIMEOUT_MS)
    if (!result.ok) {
      lastFailure =
        result.data?.error?.message ??
        (result.raw || (result.status ? `HTTP ${result.status}` : 'network error'))
      continue
    }
    const parsed = parseDraftContent(result.data?.choices?.[0]?.message?.content)
    if (!parsed) {
      lastFailure = 'the reply was not a schema-valid goal draft'
      continue
    }
    const usage = result.data?.usage
    log.info(
      {
        model: env.DEEPSEEK_MODEL,
        latencyMs: Date.now() - started,
        totalTokens: usage?.total_tokens ?? null,
        kind: parsed.kind,
        timeBudgetMinutes: parsed.timeBudgetMinutes,
      },
      'goal.draft',
    )
    return {
      ...parsed,
      // The server's three fields. A model that answered with any of them (it
      // cannot: `ModelDraft` strips them) would be overwritten here.
      automations: [],
      active: true,
      source: 'model',
    }
  }

  log.warn(
    { model: env.DEEPSEEK_MODEL, reason: lastFailure },
    'goal draft: the model did not answer with a usable draft; drafting with the local rules',
  )
  return null
}

/* ---- the local rules ----------------------------------------------------- */

/**
 * The words that decide `kind`. Mirrors the desktop's own tables, which are the
 * reference for what this parse recognises: `apps/desktop/src/lib/goals.ts`.
 */
const KIND_WORDS: Record<GoalKind, RegExp> = {
  study:
    /\b(study|problem set|pset|homework|exam|revise|revision|essay|lecture|chapter|reading|assignment|thesis|flashcards?|algorithms?|calculus|algebra)\b/i,
  work: /\b(pr|pull request|report|deck|slides|email|inbox|ship|deploy|review|spec|proposal|invoice|client|ticket|bug|feature)\b/i,
  life: /\b(taxes|budget|clean|gym|run|cook|meal|apartment|garden|call|bills?|journal|practice|guitar|piano)\b/i,
}

/** The kind a sentence with nothing recognisable in it gets. */
const DEFAULT_KIND: GoalKind = 'work'

/** Apps the sentence can name out loud. `Code` is what the desktop reports for VS Code. */
const NAMED_APPS: Array<[RegExp, string]> = [
  [/\b(vs ?code|vscode|visual studio code)\b/i, 'Code'],
  [/\b(terminal|shell|zsh|bash)\b/i, 'Terminal'],
  [/\bxcode\b/i, 'Xcode'],
  [/\bnotion\b/i, 'Notion'],
  [/\bobsidian\b/i, 'Obsidian'],
  [/\bkeynote\b/i, 'Keynote'],
  [/\b(preview|pdf)\b/i, 'Preview'],
  [/\b(numbers|spreadsheet|excel)\b/i, 'Numbers'],
  [/\bfigma\b/i, 'Figma'],
  [/\b(zoom|google meet)\b/i, 'Zoom'],
  [/\bslack\b/i, 'Slack'],
  [/\bdiscord\b/i, 'Discord'],
  [/\b(anki|flashcards?)\b/i, 'Anki'],
  [/\boverleaf\b/i, 'Overleaf'],
  [/\bmatlab\b/i, 'MATLAB'],
]

/** Apps a topic implies, so "the problem set" gets a place to do it. */
const TOPIC_APPS: Array<[RegExp, string[]]> = [
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

/**
 * The browser is always allowed: it is where an allowed site is opened, and a
 * goal whose site list is non-empty but whose app list has no browser in it
 * describes something the machine cannot actually do.
 */
const BROWSER = 'Safari'

/** Sites a topic implies. Mirrors the desktop's table. */
const TOPIC_SITES: Array<[RegExp, string[]]> = [
  [/\b(algebra|calculus|math|problem set|pset)\b/i, ['khanacademy.org', 'ocw.mit.edu']],
  [
    /\b(code|coding|algorithms?|bug|pr|deploy)\b/i,
    ['github.com', 'developer.mozilla.org', 'stackoverflow.com'],
  ],
  [/\b(essay|thesis|paper|research)\b/i, ['scholar.google.com']],
]

/** Sites the sentence can name out loud. */
const NAMED_SITES: Array<[RegExp, string]> = [
  [/\bgithub\b/i, 'github.com'],
  [/\bstack ?overflow\b/i, 'stackoverflow.com'],
  [/\bkhan ?academy\b/i, 'khanacademy.org'],
  [/\b(mit ocw|ocw)\b/i, 'ocw.mit.edu'],
  [/\bwikipedia\b/i, 'wikipedia.org'],
  [/\barxiv\b/i, 'arxiv.org'],
  [/\boverleaf\b/i, 'overleaf.com'],
  [/\bnotion\b/i, 'notion.so'],
  [/\b(scholar|google scholar)\b/i, 'scholar.google.com'],
  [/\b(duolingo)\b/i, 'duolingo.com'],
  [/\bcoursera\b/i, 'coursera.org'],
]

/**
 * The feeds. Blocked unless the sentence asks to *watch* one — "see the lecture
 * on youtube" is the goal, and blocking it would fight the person — and always
 * blocked when the sentence negates it ("no youtube"). Both readings come from
 * the sentence and nothing else.
 */
const FEEDS: Array<[RegExp, string]> = [
  [/\byoutube\b/i, 'youtube.com'],
  [/\b(twitter|x\.com)\b/i, 'x.com'],
  [/\breddit\b/i, 'reddit.com'],
  [/\binstagram\b/i, 'instagram.com'],
  [/\btiktok\b/i, 'tiktok.com'],
  [/\bfacebook\b/i, 'facebook.com'],
  [/\bnetflix\b/i, 'netflix.com'],
  [/\btwitch\b/i, 'twitch.tv'],
]

/** A feed named after one of these is the goal, not the distraction. */
const ALLOWANCE_CUE = /\b(on|from|via|using|through|watch|watching|via)\b/i

/** A sentence that says "no", "don't" or "block" is asking for the feed to go. */
const NEGATION = /\b(no|not|don'?t|doesn'?t|stop|block|ban|avoid|quit|without|never)\b/i

const ALWAYS_BLOCKED_SITES = ['youtube.com', 'x.com', 'reddit.com', 'instagram.com', 'tiktok.com']

const BLOCKED_APPS_BY_KIND: Record<GoalKind, string[]> = {
  study: ['Discord', 'Slack', 'Steam', 'Messages'],
  work: ['Discord', 'Steam'],
  life: ['Steam'],
}

/** Number words, so "two hours" is a duration and not a mystery. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
}

/**
 * "by 9", "until 21:30", "before 9am" — a clock time, which is a deadline.
 *
 * `at` is deliberately not one of these words: "look at 3 papers" reads as a
 * clock time to a rule this simple, and a budget invented from it is worse than
 * no budget at all.
 */
const CLOCK_TIME = /\b(?:by|until|before|till)\s+(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?\b/i

/** "50 minutes", "two hours", "for an hour", "half an hour" — a stated sitting. */
const DURATION =
  /\b(?:for\s+|about\s+|roughly\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*(hours?|hrs?|h|minutes?|mins?|min|m)\b/i

const BARE_HOUR = /\b(?:for|an?)\s+(hour|minute)\b/i

const HALF_HOUR = /\bhalf\s+an?\s+hour\b|\bhalf\s+hour\b/i

/** A count of deliverables, which is a done-when if anything is. */
const COUNT =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(problems?|questions?|pages?|exercises?|chapters?|tickets?|emails?|paragraphs?|slides?|lectures?|videos?)\b/i

/** A deadline word that names an hour of the day: the budget runs to that hour. */
const DEADLINE_HOURS: Array<[RegExp, number]> = [
  [/\btonight\b|\bthis evening\b|\bthis night\b/i, 22],
  [/\b(end of (the )?day|eod|today)\b/i, 18],
  [/\bthis morning\b/i, 12],
  [/\bthis afternoon\b/i, 17],
]

/**
 * A deadline word with no hour in it. A day is not a sitting: "tomorrow" states
 * a deadline, so the budget is one session toward it, not the twenty-four hours.
 */
const DEADLINE_SITTINGS: Array<[RegExp, number]> = [
  [/\btomorrow\b/i, 120],
  [/\bthis weekend\b/i, 120],
]

/** A suggestion the person can act on is at least five minutes and at most ten hours. */
const MIN_BUDGET_MINUTES = 5
const MAX_STATED_BUDGET_MINUTES = 600
const MAX_DEADLINE_BUDGET_MINUTES = 16 * 60
const MAX_TEXT_CHARS = 280

/** The ladder: what the observer is allowed to do, in the order it escalates. */
const BASE_LADDER = ['nudge', 'speak'] as const

/** A sentence that asks for a change to the machine may be permitted to make one. */
const AUTOMATE_CUES =
  /\b(block|blocks|banned|ban|mute|mutes|silenced?|do not disturb|dnd|turn off|switch off|close)\b/i

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max).trimEnd()

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

interface ClockDeadline {
  minutes: number
  /** The clock time the budget runs to, as `HH:MM`, for the done-when line. */
  hhmm: string
}

/**
 * The minutes between now and a stated clock time, with the desktop's one
 * reading rule: "by 9" said at 14:00 means 21:00, not tomorrow morning, and a
 * time already past means tomorrow. A deadline more than sixteen hours out is
 * not a sitting, so it is reported as no budget rather than as one.
 */
function clockDeadline(text: string, now: Date): ClockDeadline | null {
  const match = CLOCK_TIME.exec(text)
  if (!match) return null

  const hours = Number.parseInt(match[1] ?? '', 10)
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0
  if (!Number.isFinite(hours) || hours > 23 || minute > 59) return null

  const meridiem = match[3]?.toLowerCase()
  let hour = hours
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0

  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (!meridiem && target <= now && hour < 12) target.setHours(hour + 12)
  if (target <= now) target.setDate(target.getDate() + 1)

  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000)
  if (minutes < MIN_BUDGET_MINUTES || minutes > MAX_DEADLINE_BUDGET_MINUTES) return null

  return {
    minutes,
    hhmm: `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`,
  }
}

/** A duration the sentence states, in minutes. */
function statedMinutes(text: string): number | null {
  if (HALF_HOUR.test(text)) return 30

  const match = DURATION.exec(text)
  if (match) {
    const raw = match[1] ?? ''
    const amount = /^\d/.test(raw) ? Number.parseFloat(raw) : NUMBER_WORDS[raw]
    const unit = match[2] ?? ''
    if (amount !== undefined && Number.isFinite(amount) && amount > 0) {
      const minutes = Math.round(/^h/i.test(unit) ? amount * 60 : amount)
      return clamp(minutes, MIN_BUDGET_MINUTES, MAX_STATED_BUDGET_MINUTES)
    }
  }

  const bare = BARE_HOUR.exec(text)
  if (bare) return /hour/i.test(bare[1] ?? '') ? 60 : 1

  return null
}

/** The minutes between now and an hour named by a deadline word. */
function untilHour(hour: number, now: Date): number {
  const target = new Date(now)
  target.setHours(hour, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return clamp(
    Math.round((target.getTime() - now.getTime()) / 60_000),
    25,
    MAX_STATED_BUDGET_MINUTES,
  )
}

/**
 * The time budget, from the sentence and nothing else — clock time, then a
 * stated duration, then a deadline word. `null` when the sentence names no time:
 * the contract makes the field nullable, and a budget the person never said is
 * an invention, not a suggestion.
 */
function budgetFrom(text: string, now: Date): { minutes: number | null; doneBy: string | null } {
  const clock = clockDeadline(text, now)
  if (clock) return { minutes: clock.minutes, doneBy: clock.hhmm }

  const stated = statedMinutes(text)
  if (stated !== null) return { minutes: stated, doneBy: null }

  for (const [pattern, hour] of DEADLINE_HOURS) {
    if (pattern.test(text)) return { minutes: untilHour(hour, now), doneBy: null }
  }
  for (const [pattern, minutes] of DEADLINE_SITTINGS) {
    if (pattern.test(text)) return { minutes, doneBy: null }
  }

  return { minutes: null, doneBy: null }
}

/** Breaks follow the length of the sitting; with no length there is nothing to split. */
function breaksFor(minutes: number | null): GoalDraftBody['breakPolicy'] {
  if (minutes === null || minutes <= 35) return 'none'
  return minutes > 100 ? 'pomodoro_50_10' : 'pomodoro_25_5'
}

/**
 * The phrases that come out of the objective because they are fields of their own.
 *
 * Each is replaced by **a single space**, never by nothing, and the objective is
 * whitespace-collapsed afterwards. That is the whole defence against the one way
 * this cleanup can corrupt a sentence: a phrase that eats the separator on both
 * sides of itself joins the words around it. "finish the report by 21:30
 * tomorrow" did exactly that — the clock phrase's trailing `\s*` swallowed the
 * space before "tomorrow", the match left "reporttomorrow", and the deadline
 * phrase could no longer match a word with no boundary in front of it. Putting a
 * space back makes the passes independent of each other, whichever side of a
 * phrase a pattern happens to consume: the space is restored even when the match
 * did not take one, and collapsing means an extra one costs nothing.
 *
 * The optional `(?:\s*(?:am|pm))?` is written that way on purpose — `\s*(am|pm)?`
 * would consume the space after "21:30" even when no meridiem follows.
 */
const TIME_PHRASE = /\s*\b(?:by|until|before|till)\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\b/gi
const DURATION_PHRASE =
  /\s*\bfor\s+(?:(?:an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:\d+(?:\.\d+)?\s*)?(?:hours?|hrs?|h|minutes?|mins?|m)\b/gi
const DEADLINE_PHRASE =
  /\s*\b(?:tonight|tomorrow|this evening|this morning|this afternoon|today)\b/gi
/** "I need to…", "let's…" — a prologue, not the objective, and it ends in a space. */
const SECOND_PERSON_PREFIX =
  /^(?:i\s+(?:want|need|have|should|must)\s+to|i'?m\s+going\s+to|i\s+will|let'?s|gonna|please)\s+/i
/** "…, 8 problems" — the count is the success criterion, not the objective. */
const COUNT_ASIDE =
  /,\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:problems?|questions?|pages?|exercises?|chapters?|tickets?|emails?)\s*(?=,|$)/i

/**
 * The objective: the sentence as a short instruction. The time and the aside come
 * out of it (they are fields of their own), the second person comes off, and it is
 * cut to what the contract accepts — a 500-character sentence cannot become a
 * 500-character objective.
 *
 * No two words may be joined, at any point in this chain. The order below is the
 * order the phrases can nest in (a clock time inside a deadline), and the three
 * phrase replacements put a space back for the reason spelled out above.
 */
function objectiveFrom(text: string, fallback: string): string {
  const cleaned = text
    .replace(TIME_PHRASE, ' ')
    .replace(DURATION_PHRASE, ' ')
    .replace(DEADLINE_PHRASE, ' ')
    .replace(SECOND_PERSON_PREFIX, '')
    .replace(COUNT_ASIDE, ' ')
    // A restored space is not always a separator: "study tonight." leaves
    // "study ." and "write it, 8 pages, then rest" leaves "essay , then". Both
    // are the space-was-restored case, and both belong on the punctuation.
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/[\s,;:.!]+$/, '')
    .trim()

  const source = cleaned.length > 0 ? cleaned : fallback
  const capitalised = source.charAt(0).toUpperCase() + source.slice(1)
  return truncate(capitalised, MAX_TEXT_CHARS)
}

/** The done-when: a count if the sentence has one, else the stated clock time. */
function successFrom(text: string, doneBy: string | null): string | null {
  const count = COUNT.exec(text)
  if (count) {
    const raw = count[1] ?? ''
    const amount = /^\d/.test(raw) ? Number.parseInt(raw, 10) : NUMBER_WORDS[raw]
    const noun = (count[2] ?? '').toLowerCase()
    if (amount !== undefined) {
      return truncate(
        `All ${amount} ${amount === 1 ? noun.replace(/s$/, '') : noun} done`,
        MAX_TEXT_CHARS,
      )
    }
  }
  return doneBy ? `Done by ${doneBy}` : null
}

/** Everything the draft's lists need, decided by the words in the sentence. */
function listsFrom(
  text: string,
  kind: GoalKind,
): Pick<GoalDraftBody, 'allowedApps' | 'blockedApps' | 'allowedSites' | 'blockedSites'> {
  const apps = unique([
    ...NAMED_APPS.flatMap(([pattern, app]) => (pattern.test(text) ? [app] : [])),
    ...TOPIC_APPS.flatMap(([pattern, names]) => (pattern.test(text) ? names : [])),
  ])
  const sites = unique([
    ...NAMED_SITES.flatMap(([pattern, site]) => (pattern.test(text) ? [site] : [])),
    ...TOPIC_SITES.flatMap(([pattern, names]) => (pattern.test(text) ? names : [])),
  ])

  // A feed the sentence names is a distraction by default. It is allowed only
  // when the sentence asks to watch it and does not also negate it.
  const negated = NEGATION.test(text)
  const watched = FEEDS.flatMap(([pattern, site]) =>
    pattern.test(text) && !negated && ALLOWANCE_CUE.test(text) ? [site] : [],
  )
  const namedFeeds = FEEDS.flatMap(([pattern, site]) => (pattern.test(text) ? [site] : []))

  return {
    allowedApps: unique([BROWSER, ...apps]),
    blockedApps: [...BLOCKED_APPS_BY_KIND[kind]],
    allowedSites: unique([...sites, ...watched]),
    blockedSites: unique([...ALWAYS_BLOCKED_SITES, ...namedFeeds]).filter(
      (site) => !watched.includes(site),
    ),
  }
}

/** The escalation ladder. `nudge` and `speak` are always suggested; `automate` only if asked. */
function ladderFor(text: string, namedFeeds: string[]): GoalDraftBody['permissions'] {
  const askedForAutomation =
    AUTOMATE_CUES.test(text) || (NEGATION.test(text) && namedFeeds.length > 0)
  return askedForAutomation ? ['nudge', 'speak', 'automate'] : [...BASE_LADDER]
}

/**
 * The local draft: plain rules over the sentence, no key, no network. It never
 * throws — the caller gets a contract-valid draft whatever the sentence says.
 */
export function localDraft(sentence: string, now: Date): GoalDraftBody {
  const text = sentence.trim()
  const named = FEEDS.flatMap(([pattern, site]) => (pattern.test(text) ? [site] : []))

  try {
    const kind =
      (Object.keys(KIND_WORDS) as GoalKind[]).find((k) => KIND_WORDS[k].test(text)) ?? DEFAULT_KIND
    const budget = budgetFrom(text, now)
    const base = text.length > 0 ? text : 'Untitled goal'

    const candidate: GoalDraftBody = {
      kind,
      objective: objectiveFrom(base, base),
      successCriteria: successFrom(text, budget.doneBy),
      timeBudgetMinutes: budget.minutes,
      breakPolicy: breaksFor(budget.minutes),
      ...listsFrom(text, kind),
      permissions: ladderFor(text, named),
      // Not a suggestion either path makes: a draft never proposes a machine
      // action, and the policy is what disposes once the goal is saved.
      automations: [],
      active: true,
      source: 'local',
    }

    const parsed = GoalDraft.safeParse(candidate)
    if (parsed.success) return parsed.data

    // Unreachable by construction: every field above is built inside the
    // contract's limits. Logged rather than thrown, because a draft that
    // refuses to exist is worse than one that is plainly empty.
    log.error({ issues: parsed.error.issues }, 'local goal draft did not match the contract')
    return emptyDraft(base)
  } catch (error) {
    log.error({ err: error }, 'local goal draft failed; answering with an empty one')
    return emptyDraft(text.length > 0 ? text : 'Untitled goal')
  }
}

/** The emptiest draft the contract accepts: the sentence, and nothing inferred from it. */
function emptyDraft(objective: string): GoalDraftBody {
  return GoalDraft.parse({
    kind: DEFAULT_KIND,
    objective: truncate(objective, MAX_TEXT_CHARS) || 'Untitled goal',
    successCriteria: null,
    timeBudgetMinutes: null,
    breakPolicy: 'none',
    allowedApps: [BROWSER],
    blockedApps: [],
    allowedSites: [],
    blockedSites: [],
    permissions: [...BASE_LADDER],
    automations: [],
    active: true,
    source: 'local',
  })
}

/* ---- the step ------------------------------------------------------------ */

/**
 * Draft a goal from one sentence. The model path when a key is configured and it
 * answers with a schema-valid draft, the local rules otherwise — and `source`
 * says which. No key, no network, a timeout, a 500 from the provider or a
 * malformed reply all land on the same answer: a plain draft and `'local'`.
 */
export async function draftGoal(sentence: string, now: Date = new Date()): Promise<GoalDraftBody> {
  try {
    const suggested = await fromModel(sentence)
    if (suggested) {
      const parsed = GoalDraft.safeParse(suggested)
      if (parsed.success) return parsed.data
      log.warn({ issues: parsed.error.issues }, 'model goal draft did not match the contract')
    }
  } catch (error) {
    // A bug in the model path must not cost the person a draft.
    log.error({ err: error }, 'model goal draft failed; drafting with the local rules')
  }

  return localDraft(sentence, now)
}
