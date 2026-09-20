import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { Assessment, Intervention, SessionSummary, SignalWindow } from '@heli/contracts'

/**
 * A plausible week of demo data, for the promo shoot.
 *
 * Nine finished sessions and a few rows on the live one, against the one goal
 * this machine works on (`Finish the C++ problem set with the working written
 * up`), shaped by the rows the product actually reads rather than by what "looks
 * like data":
 *
 *   - `Observation.signals` is a `SignalWindow` (`packages/contracts/src/signal.ts`)
 *     and `Observation.assessment` an `Assessment`; the analytics service sums
 *     `focusedSeconds` / `offTaskSeconds` out of the first and decides focus out
 *     of the second, so the History screen's focused minutes, on-goal share,
 *     longest run and by-hour heatmap all come from these two columns;
 *   - `Observation.tier` / `action` / `outcome` are what the session sheet's
 *     interruption list reads (`Actions` renders `tier >= 2` only), and
 *     `Intervention` is what `/v1/analytics/tiers` groups — the "what works"
 *     panel's only input;
 *   - one observation is one minute: `Ribbon` draws one cell per observation and
 *     the heatmap buckets by the observation's own hour, so a 42-minute session
 *     is 42 rows, not one summary row.
 *
 * Three properties are deliberate:
 *
 *   - **Idempotent.** Every row this script writes has an id under `demoweek-`,
 *     so a second run deletes exactly its own rows first (`startsWith`, not a
 *     hand-kept list) and the totals come back identical. Rows it did not write
 *     — the live session's four manual spoken lines, the seeded session, the
 *     goal, its policy — are never selected, never updated, never deleted.
 *   - **Validated before it is written.** Each generated row is parsed by the
 *     real contract schema, so an over-long `evidence` line or a `tier` outside
 *     0-5 fails here, loudly, instead of degrading a dashboard through
 *     `lib/rows.ts` at read time.
 *   - **Deterministic.** The numbers come from a seeded PRNG, so a re-run
 *     differs only in nothing at all: same ids, same seconds, same totals.
 *
 * Not a product path: nothing imports this file and the server never runs it.
 * Run it with `pnpm --filter @heli/server exec tsx scripts/demo-week.ts`.
 *
 * One framing note the rows rely on. The goal's `policy` is tuned *today* for
 * the live demo (30 s windows, `consecutiveOffGoal: 1`, `minGapMs: 20_000`,
 * `maxTier: 3`) and this script does not touch it. The week's ladder assumes the
 * goal's earlier policy — the shipped defaults in `packages/contracts/src/policy.ts`
 * (`consecutiveOffGoal: 2`, `minGapMs: 90_000`, `nudgeGapMs: 180_000`) — plus a
 * machine action on the two oldest sessions and one session where the loud rung
 * was a notification. Under today's Eager numbers the first off-goal window
 * speaks immediately and there is no ambient rung to show at all. Every `reason`
 * string written here is one `observe/policy.ts` can produce.
 */

/* ---- the one row this machine is about ---------------------------------- */

/** The goal the History screen has to look right for. Never modified. */
const GOAL_ID = 'cmu90eoi30000sbhb7uw3zcip'
const GOAL_OBJECTIVE = 'Finish the C++ problem set with the working written up'

/** The live session: it gets a few rows, so its interruption count is not zero. */
const OPEN_SESSION_ID = 'cmu92zj7n0007sbmriwgf7s5e'

/** Every id this script owns. The delete is `startsWith(SESSION_PREFIX)`. */
const SESSION_PREFIX = 'demoweek-'
const OBSERVATION_PREFIX = 'demoweek-obs-'
const INTERVENTION_PREFIX = 'demoweek-int-'

/** The box is HKT and Prisma stores UTC; a "09:12 session" is 09:12 on the wall clock. */
const LOCAL_UTC_OFFSET_MINUTES = 8 * 60

/* ---- env ---------------------------------------------------------------- */

// Same rule as `src/env.ts`: the package runs with cwd = apps/server, but a run
// from the repo root should work too. Existing process env wins.
for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'apps/server/.env')]) {
  if (existsSync(path)) process.loadEnvFile(path)
}

const prisma = new PrismaClient()

/* ---- a deterministic PRNG ----------------------------------------------- */

/**
 * mulberry32: 32 bits of state, no dependency, same sequence everywhere.
 * Determinism is the point — a re-run has to produce the same totals, and "the
 * same totals" has to mean the same numbers, not the same ballpark.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (random: () => number, min: number, max: number): number => min + random() * (max - min)
const intBetween = (random: () => number, min: number, max: number): number =>
  Math.round(between(random, min, max))
const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

/** Local wall-clock instant, as the UTC `Date` Prisma stores. */
function local(day: string, minutesFromMidnight: number, seconds = 0): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(
    Date.UTC(year, month - 1, date) + minutesFromMidnight * 60_000 - LOCAL_UTC_OFFSET_MINUTES * 60_000 + seconds * 1000,
  )
}

const parseTime = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

const MINUTE_MS = 60_000

/* ---- what one minute of a session is ------------------------------------ */

type MinuteKind = 'focus' | 'idle' | 'glance' | 'drift' | 'break'

interface DriftRun {
  /** 1-based minute the run starts on. */
  at: number
  /** How many minutes it lasts. */
  minutes: number
}

interface SessionPlan {
  key: string
  /** Local date, `YYYY-MM-DD`. */
  day: string
  /** Local start, `HH:MM`. */
  start: string
  /** Length in minutes: one observation per minute. */
  minutes: number
  /** Which rung the ladder climbs: `voice` today, `nudge` where only that existed. */
  ladder: 'voice' | 'nudge'
  /** The drift run that earns a machine action, if any. */
  automationAt?: number
  /** The person undid that machine action inside the revert window. */
  automationReverted?: boolean
  runs: DriftRun[]
  /** Minutes with no input — reading, thinking, notes — still on the goal. */
  idle: number[]
  /** Minutes that touched a distractor without leaving the goal. */
  glance: number[]
  /** Minutes away from the desk. */
  breaks?: number[]
  /** Which distractor each run is spent on, in order. */
  distractors: string[]
  /** The problem in front of the person, per run. */
  problems: number[]
}

/**
 * The week: weekdays in the working day, two sessions today (the film is shot
 * before noon — nothing here is in the future), one long Thursday with a break,
 * and a Saturday morning.
 */
const PLANS: SessionPlan[] = [
  {
    key: 's01',
    day: '2026-09-14',
    start: '09:12',
    minutes: 42,
    ladder: 'voice',
    automationAt: 32,
    runs: [
      { at: 9, minutes: 1 },
      { at: 20, minutes: 2 },
      { at: 32, minutes: 3 },
    ],
    idle: [5, 17, 29, 37],
    glance: [8, 19, 31, 41],
    distractors: ['YouTube', 'X', 'YouTube'],
    problems: [4, 5, 6],
  },
  {
    key: 's02',
    day: '2026-09-15',
    start: '15:05',
    minutes: 53,
    ladder: 'voice',
    automationAt: 24,
    automationReverted: true,
    runs: [
      { at: 11, minutes: 1 },
      { at: 24, minutes: 3 },
      { at: 40, minutes: 2 },
    ],
    idle: [6, 17, 30, 45, 50],
    glance: [10, 23, 39],
    distractors: ['Reddit', 'YouTube', 'Netflix'],
    problems: [6, 7, 8],
  },
  {
    key: 's03',
    day: '2026-09-16',
    start: '09:30',
    minutes: 50,
    ladder: 'nudge',
    runs: [
      { at: 14, minutes: 2 },
      { at: 26, minutes: 2 },
      { at: 33, minutes: 3 },
      { at: 44, minutes: 1 },
    ],
    idle: [7, 20, 27, 42, 47],
    glance: [13, 25, 32],
    distractors: ['YouTube', 'X', 'YouTube', 'Reddit'],
    problems: [8, 9, 10],
  },
  {
    key: 's04',
    day: '2026-09-17',
    start: '10:00',
    minutes: 60,
    ladder: 'voice',
    runs: [
      { at: 12, minutes: 2 },
      { at: 27, minutes: 2 },
      { at: 41, minutes: 1 },
      { at: 52, minutes: 2 },
    ],
    idle: [6, 19, 25, 38, 48, 57],
    glance: [11, 26, 51],
    distractors: ['YouTube', 'Reddit', 'X', 'YouTube'],
    problems: [10, 11, 11, 12],
  },
  {
    key: 's05',
    day: '2026-09-17',
    start: '14:20',
    minutes: 75,
    ladder: 'voice',
    runs: [
      { at: 9, minutes: 2 },
      { at: 22, minutes: 2 },
      { at: 38, minutes: 4 },
      { at: 57, minutes: 1 },
      { at: 66, minutes: 2 },
    ],
    idle: [5, 15, 33, 45, 62, 71],
    glance: [8, 21, 37, 56, 65],
    breaks: [30, 31],
    distractors: ['YouTube', 'X', 'YouTube', 'Netflix', 'Reddit'],
    problems: [12, 12, 12, 12, 12],
  },
  {
    key: 's06',
    day: '2026-09-18',
    start: '09:05',
    minutes: 45,
    ladder: 'voice',
    runs: [
      { at: 16, minutes: 2 },
      { at: 29, minutes: 1 },
      { at: 37, minutes: 3 },
    ],
    idle: [5, 13, 24, 34, 41],
    glance: [15, 28, 36],
    distractors: ['YouTube', 'X', 'Reddit'],
    problems: [3, 3, 3],
  },
  {
    key: 's07',
    day: '2026-09-19',
    start: '11:00',
    minutes: 45,
    ladder: 'voice',
    runs: [
      { at: 13, minutes: 1 },
      { at: 25, minutes: 3 },
      { at: 39, minutes: 2 },
    ],
    idle: [7, 19, 31, 43],
    glance: [12, 24, 38],
    distractors: ['YouTube', 'Netflix', 'YouTube'],
    problems: [2, 2, 2],
  },
  {
    key: 's08',
    day: '2026-09-20',
    start: '06:35',
    minutes: 38,
    ladder: 'voice',
    runs: [
      { at: 10, minutes: 2 },
      { at: 22, minutes: 1 },
      { at: 31, minutes: 2 },
    ],
    idle: [6, 17, 26, 35],
    glance: [9, 21, 30],
    distractors: ['YouTube', 'Reddit', 'YouTube'],
    problems: [1, 1, 1],
  },
  {
    key: 's09',
    day: '2026-09-20',
    start: '07:40',
    minutes: 32,
    ladder: 'voice',
    runs: [
      { at: 13, minutes: 1 },
      { at: 21, minutes: 2 },
      { at: 28, minutes: 1 },
    ],
    idle: [5, 11, 19, 26],
    glance: [12, 20, 27],
    distractors: ['X', 'YouTube', 'Reddit'],
    problems: [1, 2, 2],
  },
]

/** What each distractor looks like, in the tracker's vocabulary. */
const DISTRACTOR: Record<string, { app: string; site: string; kind: string }> = {
  YouTube: { app: 'YouTube', site: 'YouTube', kind: 'video' },
  Netflix: { app: 'Netflix', site: 'Netflix', kind: 'video' },
  X: { app: 'X', site: 'X', kind: 'social' },
  Reddit: { app: 'Reddit', site: 'Reddit', kind: 'social' },
}

const ON_GOAL_APP = 'VS Code'
const SUPPORT_APPS = ['Notes', 'Browser', 'Terminal'] as const
const ON_GOAL_SITES = [
  'cppreference.com — std::vector',
  'Problem Set 3 — CS 201',
  'Overleaf — problem-set-3.tex',
  'C++ Core Guidelines',
  'Chapter 7 — Templates (course notes)',
] as const

/** The two gaps `decide()` keeps between loud rungs, under the week's policy. */
const SPEECH_GAP_MS = 90_000
const NUDGE_GAP_MS = 180_000

/* ---- generated rows ----------------------------------------------------- */

interface PlannedObservation {
  id: string
  sessionId: string
  ts: Date
  signals: unknown
  assessment: unknown
  tier: number
  action: unknown
  outcome: string | null
  confidence: number
  reason: string
  latencyMs: number
}

interface PlannedIntervention {
  id: string
  sessionId: string
  observationId: string
  tier: number
  channel: string
  message: string | null
  action: string | null
  reversible: boolean
  outcome: string | null
  reason: string
  firedAt: Date
  resolvedAt: Date | null
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** Right-align a column, spaces not zeroes: `042` is a number nobody writes. */
const align = (value: number | string, width: number): string => String(value).padStart(width)

/** One decimal, the way `services/session.ts` and `services/analytics.ts` round it. */
const oneDecimal = (value: number): number => Math.round(value * 10) / 10

/** The spoken line and the nudge, word for word as `observe/policy.ts` writes them. */
const speechMessage = (): string => `You have been off task for a bit. Let's return to "${GOAL_OBJECTIVE}".`
const nudgeMessage = (): string => `You have drifted from "${GOAL_OBJECTIVE}". Want to get back to it?`
const AUTOMATION_MESSAGE = 'Muting the distracting site for this session.'

/** One minute's rung, as the ladder would have decided it. */
interface Rung {
  tier: number
  channel: string
  message: string | null
  action: string | null
  reversible: boolean
  reason: string
}

/** Trim to a contract limit without ever exceeding it (`evidence` 140, `because` 200, message 220). */
const fit = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/* ---- one minute's signals ---------------------------------------------- */

interface MinuteContext {
  sessionId: string
  kind: MinuteKind
  /** Local minute number in the session, 1-based. */
  minute: number
  /** Start of the window, i.e. `from`; `to` is a minute later. */
  from: Date
  problem: number
  /** The distractor this minute is spent on, when it is spent on one. */
  distractor: { app: string; site: string; kind: string }
  /** Seconds of the window that were off the goal (glance and drift minutes). */
  offSeconds: number
  /** How long the drift has lasted by the end of this window. */
  driftSeconds: number
  random: () => number
}

/**
 * The window, built the way `services/signals.ts` folds one: everything a person
 * did in sixty seconds, split into focus, off-task and idle — and idle carved
 * *out* of the classification rather than added to it, so the three never sum
 * past the window.
 */
function signalsFor(context: MinuteContext): unknown {
  const { random, kind } = context
  const window = {
    from: context.from.toISOString(),
    to: new Date(context.from.getTime() + MINUTE_MS).toISOString(),
    windowMs: MINUTE_MS,
    focusMode: false,
    lastFrameRef: `sessions/${context.sessionId}/camera/latest.jpg`,
    lastScreenRef: `screen_${intBetween(random, 40000, 49999)}_${intBetween(random, 1, 3)}`,
  }

  const site = pick(random, ON_GOAL_SITES)
  const support = pick(random, SUPPORT_APPS)

  switch (kind) {
    case 'focus': {
      const editor = 38 + Math.round(between(random, 0, 14))
      const focused = 60
      return {
        ...window,
        focusedSeconds: focused,
        offTaskSeconds: 0,
        idleSeconds: 0,
        contextSwitches: intBetween(random, 0, 1),
        longestFocusRunSeconds: focused,
        inputRate: Math.round(between(random, 42, 96)),
        onTaskRatio: 1,
        topApps: [
          { app: ON_GOAL_APP, seconds: editor, onTask: true },
          { app: support, seconds: focused - editor, onTask: true },
        ],
        topSites: [{ title: site, seconds: Math.round(between(random, 18, 45)), onTask: true }],
      }
    }
    case 'idle': {
      const focused = Math.round(between(random, 40, 48))
      return {
        ...window,
        focusedSeconds: focused,
        offTaskSeconds: 0,
        idleSeconds: 60 - focused,
        contextSwitches: 0,
        longestFocusRunSeconds: focused,
        inputRate: 0,
        onTaskRatio: 1,
        topApps: [
          { app: ON_GOAL_APP, seconds: focused, onTask: true },
          { app: support, seconds: 60 - focused, onTask: true },
        ],
        topSites: [{ title: site, seconds: focused, onTask: true }],
      }
    }
    case 'glance': {
      const focused = 60 - context.offSeconds
      return {
        ...window,
        focusedSeconds: focused,
        offTaskSeconds: context.offSeconds,
        idleSeconds: 0,
        contextSwitches: intBetween(random, 1, 2),
        longestFocusRunSeconds: focused,
        inputRate: Math.round(between(random, 14, 34)),
        onTaskRatio: Math.round((focused / 60) * 100) / 100,
        topApps: [
          { app: ON_GOAL_APP, seconds: focused, onTask: true },
          { app: context.distractor.app, seconds: context.offSeconds, onTask: false },
        ],
        topSites: [{ title: context.distractor.site, seconds: context.offSeconds, onTask: false }],
      }
    }
    case 'drift': {
      const off = 60
      return {
        ...window,
        focusedSeconds: 0,
        offTaskSeconds: off,
        idleSeconds: 0,
        contextSwitches: intBetween(random, 1, 3),
        longestFocusRunSeconds: 0,
        inputRate: Math.round(between(random, 4, 38)),
        onTaskRatio: Math.round(between(random, 5, 25)) / 100,
        topApps: [
          { app: context.distractor.app, seconds: Math.round(between(random, 45, 58)), onTask: false },
          { app: ON_GOAL_APP, seconds: Math.round(between(random, 2, 12)), onTask: true },
        ],
        topSites: [{ title: context.distractor.site, seconds: off, onTask: false }],
      }
    }
    case 'break': {
      return {
        ...window,
        focusedSeconds: 0,
        offTaskSeconds: 0,
        idleSeconds: 60,
        contextSwitches: 0,
        longestFocusRunSeconds: 0,
        inputRate: 0,
        onTaskRatio: 0,
        topApps: [],
        topSites: [],
      }
    }
  }
}

/**
 * The assessment for one minute, in the vocabulary `observe/prompts/assess.md`
 * asks the model for: an open `activity`, a `kind` only when off task, evidence
 * lines that name the frame they came from, and one factual `because`.
 *
 * `goalId` rides along in the JSON (the column is untyped `Json` and the read
 * path parses with the contract, which strips what it does not name) so a query
 * over the table can see which goal each minute was judged against.
 */
function assessmentFor(context: MinuteContext): unknown {
  const { random, kind } = context
  const site = context.distractor.site
  const problem = context.problem

  const deskSeated = pick(random, [
    'desk: person at the desk, hands on the keyboard, eyes on the screen',
    'desk: person in front of the laptop, notes open beside it',
    'desk: person at the desk leaning in toward the screen, pen in hand',
  ])
  const metrics = (line: string): string => `metrics: ${line}`

  switch (kind) {
    case 'focus':
      return {
        goalId: GOAL_ID,
        onTask: true,
        activity: pick(random, ['working', 'reading']),
        kind: null,
        driftSeconds: 0,
        evidence: [
          deskSeated,
          fit(`screen: VS Code frontmost, problem-set-3.cpp open at problem ${problem}, build output clean`, 140),
          fit(
            metrics(
              `input ${intBetween(random, 40, 96)} events/30s, focused 60s, ${intBetween(random, 0, 1)} switch, no idle in the window`,
            ),
            140,
          ),
        ],
        confidence: Math.round(between(random, 0.62, 0.92) * 100) / 100,
        because: fit(`Problem ${problem} is under way in the editor with steady input and nothing else in front.`, 200),
      }
    case 'idle':
      return {
        goalId: GOAL_ID,
        onTask: true,
        activity: 'reading',
        kind: null,
        driftSeconds: 0,
        evidence: [
          'desk: person still at the desk, head down over the notes, no hands on the keyboard',
          'screen: the same editor page as the last window, nothing moved',
          fit(
            metrics(
              `input 0 events/30s, idle ${intBetween(random, 12, 20)}s of 60, still the problem set in front`,
            ),
            140,
          ),
        ],
        confidence: Math.round(between(random, 0.55, 0.7) * 100) / 100,
        because: fit(
          `No input this window, but the editor and the working are still in front — reading, not drifting.`,
          200,
        ),
      }
    case 'glance':
      return {
        goalId: GOAL_ID,
        onTask: true,
        activity: 'browsing',
        kind: null,
        driftSeconds: context.driftSeconds,
        evidence: [
          'desk: hand off the keyboard, eyes still on the screen',
          fit(`screen: ${site} in front for ${context.offSeconds}s with the editor behind it`, 140),
          fit(
            metrics(
              `input ${intBetween(random, 14, 34)} events/30s, off task ${context.offSeconds}s of 60, back in the editor`,
            ),
            140,
          ),
        ],
        confidence: Math.round(between(random, 0.6, 0.76) * 100) / 100,
        because: fit(
          `A short look at ${site} without leaving problem ${problem}; not worth interrupting.`,
          200,
        ),
      }
    case 'drift':
      return {
        goalId: GOAL_ID,
        onTask: false,
        activity: context.distractor.kind === 'video' ? 'video' : 'browsing',
        kind: context.distractor.kind,
        driftSeconds: context.driftSeconds,
        evidence: [
          'desk: person leaning back, watching the screen, no hands on the keyboard',
          fit(`screen: ${site} frontmost for ${context.offSeconds}s of the window, editor not visible`, 140),
          fit(
            metrics(
              `input ${intBetween(random, 4, 30)} events/30s, off task ${context.driftSeconds}s and rising, ${intBetween(random, 1, 3)} switches`,
            ),
            140,
          ),
        ],
        confidence: Math.round(between(random, 0.72, 0.95) * 100) / 100,
        because: fit(
          `${site} has been in front for ${context.driftSeconds}s and the problem set is not on screen.`,
          200,
        ),
      }
    case 'break':
      return {
        goalId: GOAL_ID,
        onTask: true,
        activity: 'break',
        kind: null,
        driftSeconds: 0,
        evidence: [
          'desk: empty chair, nobody in frame',
          'screen: no application in front, display asleep',
          fit(metrics(`input 0 events/30s, idle 60s of 60`), 140),
        ],
        confidence: Math.round(between(random, 0.6, 0.8) * 100) / 100,
        because: 'Nobody at the desk this minute; the session is paused, not drifting.',
      }
  }
}

/* ---- one session -------------------------------------------------------- */

/**
 * Build a session's minutes.
 *
 * The ladder is `observe/policy.ts` read back: the first off-goal window is an
 * ambient change (`not_sustained` — the drift is real but not yet sustained),
 * the next one earns the loud rung, and a rung whose gap has not passed leaves
 * the tray colour as `voice_first_gap`. Each loud rung is judged by the *next*
 * window's assessment (`pendingOutcome` in `observe/index.ts`): back on task is
 * `resolved`, still off task is `ignored`.
 */
function planSession(
  plan: SessionPlan,
  sessionId: string,
): { observations: PlannedObservation[]; interventions: PlannedIntervention[] } {
  const random = rng(plan.key.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7))
  const startAt = local(plan.day, parseTime(plan.start))

  const runAt = new Map<number, { index: number; offset: number }>()
  plan.runs.forEach((run, index) => {
    for (let offset = 0; offset < run.minutes; offset += 1) runAt.set(run.at + offset, { index, offset })
  })

  const observations: PlannedObservation[] = []
  const interventions: PlannedIntervention[] = []
  let pending: { observationId: string; interventionId: string } | null = null
  let lastSpeechAt = Number.NEGATIVE_INFINITY
  let lastNudgeAt = Number.NEGATIVE_INFINITY
  let previousIgnored = false
  let offGoalCount = 0
  let automationFired = false

  for (let minute = 1; minute <= plan.minutes; minute += 1) {
    const from = new Date(startAt.getTime() + (minute - 1) * MINUTE_MS)
    const run = runAt.get(minute)
    const kind: MinuteKind = run
      ? 'drift'
      : (plan.breaks ?? []).includes(minute)
        ? 'break'
        : plan.idle.includes(minute)
          ? 'idle'
          : plan.glance.includes(minute)
            ? 'glance'
            : 'focus'

    if (kind === 'drift') offGoalCount += 1
    else offGoalCount = 0

    const runIndex = run ? run.index : 0
    const name = plan.distractors[runIndex] ?? 'YouTube'
    const distractor = DISTRACTOR[name] ?? DISTRACTOR.YouTube!
    const offSeconds = kind === 'drift' ? 60 : kind === 'glance' ? intBetween(random, 16, 26) : 0

    // The previous loud rung is judged by this window, exactly as the loop does
    // before it decides anything new. A machine action the person undid inside
    // `revertWindowMs` is `reverted` instead — that verdict comes from the revert
    // window, not from the next window's assessment.
    if (pending !== null) {
      const intervention = interventions.find((row) => row.id === pending?.interventionId)
      const reverted = plan.automationReverted === true && intervention?.tier === 4
      const outcome = reverted ? 'reverted' : kind === 'drift' ? 'ignored' : 'resolved'
      const observation = observations.find((row) => row.id === pending?.observationId)
      if (observation) observation.outcome = outcome
      if (intervention) {
        intervention.outcome = outcome
        intervention.resolvedAt = outcome === 'resolved' || outcome === 'reverted' ? from : null
      }
      previousIgnored = outcome === 'ignored'
      pending = null
    }

    const ts = new Date(from.getTime() + MINUTE_MS + intBetween(random, 2000, 7000))

    let rung: Rung | null = null
    if (kind === 'drift') {
      if (offGoalCount <= 1) {
        rung = {
          tier: 1,
          channel: 'ambient',
          message: null,
          action: null,
          reversible: false,
          reason: 'tier1:ambient:not_sustained',
        }
      } else if (plan.automationAt !== undefined && minute === plan.automationAt + 2 && !automationFired) {
        rung = {
          tier: 4,
          channel: 'automation',
          message: AUTOMATION_MESSAGE,
          action: 'mute_site',
          reversible: true,
          reason: 'tier4:automation:speak_ignored',
        }
        automationFired = true
      } else if (plan.ladder === 'voice' && ts.getTime() - lastSpeechAt >= SPEECH_GAP_MS) {
        rung = {
          tier: 3,
          channel: 'speech',
          message: speechMessage(),
          action: null,
          reversible: false,
          reason: previousIgnored ? 'tier3:speak:max_tier' : 'tier3:speak:voice_first',
        }
      } else if (plan.ladder === 'nudge' && ts.getTime() - lastNudgeAt >= NUDGE_GAP_MS) {
        rung = {
          tier: 2,
          channel: 'notification',
          message: nudgeMessage(),
          action: null,
          reversible: false,
          reason: 'tier2:nudge:nudge_due',
        }
      } else {
        rung = {
          tier: 1,
          channel: 'ambient',
          message: null,
          action: null,
          reversible: false,
          reason: plan.ladder === 'voice' ? 'tier1:ambient:voice_first_gap' : 'tier1:ambient:nudge_gap',
        }
      }

      if (rung.tier === 3) lastSpeechAt = ts.getTime()
      if (rung.tier === 2) lastNudgeAt = ts.getTime()

      const observationId = `${OBSERVATION_PREFIX}${plan.key}-${pad(minute, 3)}`
      /**
       * `action` is the intervention the loop would have carried on this row.
       * The `Intervention` table gets a row for every rung here, including the
       * ambient one — `observe/persistence.ts` only persists tier >= 2, but the
       * History screen's "what brings you back" panel is a `GROUP BY` over that
       * table and has a name for the Light rung (and no verdict for it, which is
       * what an unjudged ambient change honestly is).
       */
      const action = {
        tier: rung.tier,
        channel: rung.channel,
        message: rung.message,
        action: rung.action,
        reversible: rung.reversible,
        reason: rung.reason,
      }

      const context: MinuteContext = {
        sessionId,
        kind,
        minute,
        from,
        problem: plan.problems[runIndex] ?? 1,
        distractor,
        offSeconds,
        driftSeconds: driftSecondsFor(offGoalCount),
        random,
      }
      const assessment = assessmentFor(context) as { confidence: number }

      observations.push({
        id: observationId,
        sessionId,
        ts,
        signals: signalsFor(context),
        assessment,
        tier: rung.tier,
        action,
        outcome: null,
        confidence: assessment.confidence,
        reason: rung.reason,
        latencyMs: intBetween(random, 3200, 6800),
      })

      const interventionId = `${INTERVENTION_PREFIX}${plan.key}-${pad(minute, 3)}`
      interventions.push({
        id: interventionId,
        sessionId,
        observationId,
        tier: rung.tier,
        channel: rung.channel,
        message: rung.message,
        action: rung.action,
        reversible: rung.reversible,
        outcome: null,
        reason: rung.reason,
        firedAt: new Date(ts.getTime() + intBetween(random, 200, 1500)),
        resolvedAt: null,
      })
      if (rung.tier >= 2) pending = { observationId, interventionId }
      continue
    }

    const context: MinuteContext = {
      sessionId,
      kind,
      minute,
      from,
      problem: plan.problems[runIndex] ?? 1,
      distractor,
      offSeconds,
      driftSeconds: 0,
      random,
    }
    const assessment = assessmentFor(context) as { confidence: number }
    observations.push({
      id: `${OBSERVATION_PREFIX}${plan.key}-${pad(minute, 3)}`,
      sessionId,
      ts,
      signals: signalsFor(context),
      assessment,
      tier: 0,
      action: null,
      outcome: null,
      confidence: assessment.confidence,
      reason: 'tier0:silent',
      latencyMs: intBetween(random, 3200, 6800),
    })
  }

  return { observations, interventions }
}

/** `driftSeconds` is cumulative within a run: the window shows how long it has been going. */
function driftSecondsFor(offGoalCount: number): number {
  return 40 + (offGoalCount - 1) * 60
}

/* ---- the roll-up, folded exactly as `services/session.ts` folds it ------- */

interface FoldableObservation {
  tier: number
  outcome: string | null
  signals: unknown
  assessment: unknown
}

const asSignals = (row: FoldableObservation): { focusedSeconds: number; offTaskSeconds: number; topApps: { app: string }[]; topSites: { title: string }[] } =>
  row.signals as never
const asAssessment = (row: FoldableObservation): { onTask: boolean; activity: string; kind: string | null } | null =>
  row.assessment as never

const countsAsFocus = (row: FoldableObservation): boolean => {
  const assessment = asAssessment(row)
  if (!assessment || !assessment.onTask) return false
  return assessment.activity !== 'break'
}

/** The goal in one noun, as the summary line wants it. */
const goalNoun = (objective: string): string =>
  objective.replace(/^(finish|write|do|complete)\s+(the\s+)?/i, '').toLowerCase()

/**
 * The contract's `SessionSummary`, folded out of the session's own windows — the
 * same numbers `GET /v1/sessions/:id` will recompute from the rows on read, so
 * the cached column and the live answer cannot disagree.
 */
function summarise(rows: FoldableObservation[]): unknown {
  let focusedSeconds = 0
  let offTaskSeconds = 0
  let run = 0
  let longestRunSeconds = 0
  const distraction = new Map<string, number>()
  const worked = new Map<string, { tier: number; outcome: string; count: number }>()

  for (const row of rows) {
    const signals = asSignals(row)
    focusedSeconds += signals.focusedSeconds
    offTaskSeconds += signals.offTaskSeconds
    if (countsAsFocus(row)) {
      run += signals.focusedSeconds
      longestRunSeconds = Math.max(longestRunSeconds, run)
    } else {
      run = 0
    }

    const assessment = asAssessment(row)
    if (assessment && !assessment.onTask) {
      const key =
        signals.topSites[0]?.title ?? (assessment.kind === 'phone' ? 'Phone' : (signals.topApps[0]?.app ?? 'Unknown'))
      distraction.set(key, (distraction.get(key) ?? 0) + signals.offTaskSeconds)
    }
    if (row.tier > 0 && row.outcome !== null) {
      const id = `${row.tier}:${row.outcome}`
      const entry = worked.get(id) ?? { tier: row.tier, outcome: row.outcome, count: 0 }
      entry.count += 1
      worked.set(id, entry)
    }
  }

  const focusedMinutes = Math.round((focusedSeconds / 60) * 10) / 10
  const loud = rows.filter((row) => row.tier >= 2)
  const landed = loud.filter((row) => row.outcome === 'resolved')

  return {
    focusedMinutes,
    offTaskMinutes: Math.round((offTaskSeconds / 60) * 10) / 10,
    longestFocusRunSeconds: longestRunSeconds,
    topDistraction: [...distraction.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    worked: [...worked.values()].sort((a, b) => a.tier - b.tier || a.outcome.localeCompare(b.outcome)),
    message:
      loud.length === 0
        ? `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(GOAL_OBJECTIVE)}. Nothing needed saying.`
        : `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(GOAL_OBJECTIVE)}. ${landed.length} of ${loud.length} interruptions brought you back.`,
  }
}

/* ---- the live session --------------------------------------------------- */

/**
 * A few minutes of the session that is still open.
 *
 * Today's policy is the Eager one in the row — `consecutiveOffGoal: 1` — so the
 * first off-goal window speaks and there is no ambient rung: the ladder these
 * rows show is the one the running server would produce right now. Outcomes are
 * left null on purpose: a live intervention has not been judged yet, and that is
 * what the desktop's interruption list prints as "…".
 */
function planOpenSession(
  sessionId: string,
  startedAt: Date,
  now: Date,
): { observations: PlannedObservation[]; interventions: PlannedIntervention[] } {
  const random = rng(0x5eed)
  const script: { offset: number; kind: MinuteKind }[] = [
    { offset: 2, kind: 'drift' },
    { offset: 4, kind: 'focus' },
    { offset: 6, kind: 'drift' },
    { offset: 8, kind: 'idle' },
  ]

  const observations: PlannedObservation[] = []
  const interventions: PlannedIntervention[] = []
  let offGoalCount = 0

  for (const [index, step] of script.entries()) {
    const from = new Date(startedAt.getTime() + step.offset * MINUTE_MS)
    const to = new Date(from.getTime() + MINUTE_MS)
    // Only minutes that have actually happened: this session is being filmed.
    if (to.getTime() > now.getTime() - 5000) break

    if (step.kind === 'drift') offGoalCount += 1
    else offGoalCount = 0

    const name = step.kind === 'drift' ? (['YouTube', 'X'] as const)[offGoalCount - 1] ?? 'YouTube' : 'YouTube'
    const distractor = DISTRACTOR[name] ?? DISTRACTOR.YouTube!
    const context: MinuteContext = {
      sessionId,
      kind: step.kind,
      minute: index + 1,
      from,
      problem: 1,
      distractor,
      offSeconds: step.kind === 'drift' ? 60 : 0,
      driftSeconds: step.kind === 'drift' ? driftSecondsFor(offGoalCount) : 0,
      random,
    }
    const ts = new Date(to.getTime() + intBetween(random, 2000, 7000))
    const assessment = assessmentFor(context) as { confidence: number }
    const observationId = `${OBSERVATION_PREFIX}open-${pad(index + 1, 2)}`

    if (step.kind !== 'drift') {
      observations.push({
        id: observationId,
        sessionId,
        ts,
        signals: signalsFor(context),
        assessment,
        tier: 0,
        action: null,
        outcome: null,
        confidence: assessment.confidence,
        reason: 'tier0:silent',
        latencyMs: intBetween(random, 3200, 6800),
      })
      continue
    }

    const reason = 'tier3:speak:voice_first'
    observations.push({
      id: observationId,
      sessionId,
      ts,
      signals: signalsFor(context),
      assessment,
      tier: 3,
      action: { tier: 3, channel: 'speech', message: speechMessage(), action: null, reversible: false, reason },
      outcome: null,
      confidence: assessment.confidence,
      reason,
      latencyMs: intBetween(random, 3200, 6800),
    })
    interventions.push({
      id: `${INTERVENTION_PREFIX}open-${pad(index + 1, 2)}`,
      sessionId,
      observationId,
      tier: 3,
      channel: 'speech',
      message: speechMessage(),
      action: null,
      reversible: false,
      outcome: null,
      reason,
      firedAt: new Date(ts.getTime() + intBetween(random, 200, 1500)),
      resolvedAt: null,
    })
  }

  return { observations, interventions }
}

/* ---- contract checks ---------------------------------------------------- */

/**
 * Parse every generated row with the real schema before it reaches Postgres.
 * A failure here is a bug in this file: `lib/rows.ts` would otherwise null the
 * field (or drop the whole observation) at read time, and the dashboard would
 * quietly lose the minutes this script exists to seed.
 */
function validate(observations: PlannedObservation[], interventions: PlannedIntervention[]): void {
  for (const row of observations) {
    SignalWindow.parse(row.signals)
    Assessment.parse(row.assessment)
    if (row.action !== null) Intervention.parse(row.action)
    if (row.outcome !== null && !['resolved', 'ignored', 'reverted'].includes(row.outcome)) {
      throw new Error(`observation ${row.id}: outcome ${row.outcome} is not one of the four`)
    }
  }
  for (const row of interventions) {
    Intervention.parse({
      tier: row.tier,
      channel: row.channel,
      message: row.message,
      action: row.action,
      reversible: row.reversible,
      reason: row.reason,
    })
  }
}

/* ---- what was written --------------------------------------------------- */

interface Written {
  sessions: number
  observations: number
  interventions: number
  focusedMinutes: number
  offTaskMinutes: number
  longestRunSeconds: number
  openObservations: number
  openInterventions: number
}

const localStamp = (date: Date): string =>
  new Date(date.getTime() + LOCAL_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 16).replace('T', ' ')

const minutes = (seconds: number): string => `${Math.round(seconds / 60)}m`

async function main(): Promise<void> {
  const goal = await prisma.goal.findUnique({ where: { id: GOAL_ID } })
  if (goal === null) throw new Error(`No goal ${GOAL_ID}. Seed the goal first — this script never creates one.`)
  const device = await prisma.device.findFirst({ orderBy: { createdAt: 'asc' } })
  if (device === null) throw new Error('No device registered. Run `pnpm --filter @heli/server db:seed` first.')

  const line = (text = ''): void => void process.stdout.write(`${text}\n`)
  line('helicopter · demo week')
  line(`  goal    ${goal.id}  ${goal.objective}`)
  line(`  device  ${device.id} (${device.name})`)
  line(`  policy  ${JSON.stringify(goal.policy)}`)
  line(`  ladder  the week is seeded under the goal's earlier policy (see the note at the top of this file)`)
  line()

  // 1. Remove exactly this script's rows. `startsWith` on its own prefixes, so a
  //    second run replaces its data instead of doubling it, and nothing that
  //    lives outside that prefix is ever in the where clause.
  const removedInterventions = await prisma.intervention.deleteMany({
    where: { id: { startsWith: INTERVENTION_PREFIX } },
  })
  const removedObservations = await prisma.observation.deleteMany({
    where: { id: { startsWith: OBSERVATION_PREFIX } },
  })
  const removedSessions = await prisma.session.deleteMany({ where: { id: { startsWith: SESSION_PREFIX } } })
  line(
    `  removed ${removedSessions.count} sessions, ${removedObservations.count} observations, ${removedInterventions.count} interventions from the previous run`,
  )
  line()

  // 2. Plan the week and validate it against the contracts.
  const planned = PLANS.map((plan) => ({ plan, ...planSession(plan, `${SESSION_PREFIX}${plan.key}`) }))
  const openSession = await prisma.session.findUnique({ where: { id: OPEN_SESSION_ID } })
  const openIsLive = openSession !== null && openSession.endedAt === null
  const open = openIsLive
    ? planOpenSession(OPEN_SESSION_ID, openSession.startedAt, new Date())
    : { observations: [], interventions: [] }

  const allObservations = [...planned.flatMap((entry) => entry.observations), ...open.observations]
  const allInterventions = [...planned.flatMap((entry) => entry.interventions), ...open.interventions]
  validate(allObservations, allInterventions)

  // 3. Sessions and their cached roll-ups.
  const sessionRows = planned.map(({ plan, observations }) => {
    const startedAt = local(plan.day, parseTime(plan.start))
    const endedAt = new Date(startedAt.getTime() + plan.minutes * MINUTE_MS + 4000)
    const summary = SessionSummary.parse(summarise(observations))
    return { id: `${SESSION_PREFIX}${plan.key}`, plan, startedAt, endedAt, summary, observations }
  })

  await prisma.session.createMany({
    data: sessionRows.map((row) => ({
      id: row.id,
      goalId: goal.id,
      deviceId: device.id,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      summary: row.summary as never,
    })),
  })

  // 4. Observations then interventions, in chunks: one statement per table would
  //    be a 440-row insert, and one per row would be 500 round trips.
  for (let start = 0; start < allObservations.length; start += 200) {
    await prisma.observation.createMany({
      data: allObservations.slice(start, start + 200).map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        ts: row.ts,
        signals: row.signals as never,
        assessment: row.assessment as never,
        tier: row.tier,
        action: row.action as never,
        outcome: row.outcome,
        confidence: row.confidence,
        reason: row.reason,
        latencyMs: row.latencyMs,
      })),
    })
  }
  for (let start = 0; start < allInterventions.length; start += 200) {
    await prisma.intervention.createMany({
      data: allInterventions.slice(start, start + 200).map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        observationId: row.observationId,
        tier: row.tier,
        channel: row.channel,
        message: row.message,
        action: row.action as never,
        reversible: row.reversible,
        outcome: row.outcome,
        reason: row.reason,
        firedAt: row.firedAt,
        resolvedAt: row.resolvedAt,
      })),
    })
  }

  /* ---- report ----------------------------------------------------------- */

  line('  when (HKT)              min  focused    off  longest  obs  rungs  tier mix')
  let focusedSeconds = 0
  let offTaskSeconds = 0
  let longestRun = 0
  const tierCounts = new Map<number, { total: number; resolved: number; judged: number }>()

  for (const row of sessionRows) {
    let run = 0
    let sessionLongest = 0
    let sessionFocused = 0
    let sessionOff = 0
    for (const observation of row.observations) {
      const signals = asSignals(observation)
      sessionFocused += signals.focusedSeconds
      sessionOff += signals.offTaskSeconds
      if (countsAsFocus(observation)) {
        run += signals.focusedSeconds
        sessionLongest = Math.max(sessionLongest, run)
      } else {
        run = 0
      }
      if (observation.tier > 0) {
        const entry = tierCounts.get(observation.tier) ?? { total: 0, resolved: 0, judged: 0 }
        entry.total += 1
        if (observation.outcome !== null) {
          entry.judged += 1
          if (observation.outcome === 'resolved') entry.resolved += 1
        }
        tierCounts.set(observation.tier, entry)
      }
    }
    focusedSeconds += sessionFocused
    offTaskSeconds += sessionOff
    longestRun = Math.max(longestRun, sessionLongest)

    const tierMix = new Map<number, number>()
    for (const intervention of row.observations) {
      if (intervention.tier === 0) continue
      tierMix.set(intervention.tier, (tierMix.get(intervention.tier) ?? 0) + 1)
    }
    const mix = [...tierMix.entries()].sort((a, b) => a[0] - b[0]).map(([tier, count]) => `t${tier}:${count}`).join(' ')
    line(
      `  ${localStamp(row.startedAt)}–${localStamp(row.endedAt).slice(11)}  ${align(row.plan.minutes, 3)}  ` +
        `${oneDecimal(sessionFocused / 60).toFixed(1).padStart(7)}  ${oneDecimal(sessionOff / 60).toFixed(1).padStart(5)}  ` +
        `${minutes(sessionLongest).padStart(7)}  ${align(row.observations.length, 3)}  ` +
        `${align(row.observations.filter((o) => o.tier > 0).length, 5)}  ${mix}`,
    )
  }

  const total = focusedSeconds + offTaskSeconds
  line()
  line(
    `  totals: ${sessionRows.length} sessions, ${allObservations.length} observations, ${allInterventions.length} interventions`,
  )
  line(
    `          focused ${oneDecimal(focusedSeconds / 60).toFixed(1)} min · off task ${oneDecimal(offTaskSeconds / 60).toFixed(1)} min · on goal ${total ? Math.round((focusedSeconds / total) * 100) : 0}% · longest run ${longestRun}s (${minutes(longestRun)})`,
  )
  const effect = [...tierCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, entry]) => {
      const name = { 1: 'Light', 2: 'Nudge', 3: 'Voice', 4: 'Change', 5: 'Summary' }[tier] ?? `Tier ${tier}`
      const rate = entry.judged === 0 ? 'unjudged' : `${Math.round((entry.resolved / entry.judged) * 100)}% of ${entry.judged}`
      return `${name} ${entry.total} (${rate})`
    })
    .join(' · ')
  line(`          what works: ${effect}`)

  // The seven-day series the History screen draws, oldest first.
  const days = new Map<string, { focused: number; off: number; sessions: number }>()
  for (const row of sessionRows) {
    const key = localStamp(row.startedAt).slice(0, 10)
    const entry = days.get(key) ?? { focused: 0, off: 0, sessions: 0 }
    for (const observation of row.observations) {
      const signals = asSignals(observation)
      entry.focused += signals.focusedSeconds / 60
      entry.off += signals.offTaskSeconds / 60
    }
    entry.sessions += 1
    days.set(key, entry)
  }
  line()
  line('  last 7 days (what the History chart draws):')
  for (const [key, entry] of [...days.entries()].sort()) {
    line(
      `    ${key}  ${entry.sessions} session${entry.sessions === 1 ? ' ' : 's'}  ${entry.focused.toFixed(0).padStart(4)} focused  ${entry.off.toFixed(0).padStart(3)} off task`,
    )
  }

  line()
  if (openIsLive) {
    line(
      `  open session ${OPEN_SESSION_ID} left open: +${open.observations.length} observations, +${open.interventions.length} interventions`,
    )
  } else {
    line(`  open session ${OPEN_SESSION_ID} is not open any more; skipped (nothing about it is touched either way)`)
  }
  const stillOpen = await prisma.session.findUnique({ where: { id: OPEN_SESSION_ID } })
  const goalAfter = await prisma.goal.findUnique({ where: { id: GOAL_ID } })
  line(`  goal policy after the run: ${JSON.stringify(goalAfter?.policy)}`)
  line(`  open session after the run: endedAt=${String(stillOpen?.endedAt)}`)
  line()

  const written: Written = {
    sessions: sessionRows.length,
    observations: allObservations.length,
    interventions: allInterventions.length,
    focusedMinutes: Math.round((focusedSeconds / 60) * 10) / 10,
    offTaskMinutes: Math.round((offTaskSeconds / 60) * 10) / 10,
    longestRunSeconds: longestRun,
    openObservations: open.observations.length,
    openInterventions: open.interventions.length,
  }
  line(
    `  wrote ${written.sessions} sessions / ${written.observations} observations / ${written.interventions} interventions; ` +
      `re-running replaces them under the ${SESSION_PREFIX}* ids`,
  )
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`demo-week failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
