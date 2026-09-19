import { Policy, SignalWindow } from '@heli/contracts'
import type { Signal, SignalSource, SignalWindow as SignalWindowContract } from '@heli/contracts'
import { z } from 'zod'

import { publish } from '../lib/bus.js'
import { prisma } from '../lib/prisma.js'
import { childLogger } from '../logger.js'
import { latestFrameRef } from './frames.js'

const log = childLogger({ module: 'signals' })

/**
 * Desktop signal intake, and the fold that turns a stream of raw app / window /
 * input / idle signals into the derived `SignalWindow` the model, the policy and
 * the console all read.
 *
 * Three things shape this file:
 *
 *   - **One code path.** The desktop reaches the server twice — batched over
 *     `POST /v1/signals` when it was offline, live over `/ws/desktop` when it is
 *     not — and both land here, in `ingestSignals`. `DesktopSignals` is
 *     `SignalBatch` verbatim for exactly this reason, so there is no second
 *     definition of "a batch of signals" to drift.
 *   - **The window is derived, never sent.** A client that could post a window
 *     could post `onTaskRatio: 1`, and the policy would act on it. Every number
 *     below is computed here from signals plus the session's goal.
 *   - **Bounded.** A ring of a few thousand projected signals per session holds
 *     counts and titles only: no payload bodies, no bytes, no frames, and a
 *     hard ceiling on what a desktop that never stops talking can cost us.
 *
 * The vocabulary of the signals this understands is documented at each step
 * below. `kind` is an open vocabulary in the contract, so anything unrecognised
 * is still accepted, counted and stored — it just does not move a metric, which
 * is why the fold reads payload *fields* (`app`, `url`, `count`, `idle`, …)
 * rather than matching kind strings wherever it can.
 *
 * Two things the row's phase doc asks for are *not* in `SignalWindow`, and are
 * deliberately not smuggled in as extra fields — contracts are law, and a field
 * the clients cannot parse is worse than a missing one:
 *
 *   - **break compliance.** The goal carries `breakPolicy`, but no window field
 *     says whether a break was taken, owed or skipped, so there is nowhere to
 *     report it. `goal.breakPolicy` and `idleSeconds` are what exists today;
 *     computing compliance needs a field in `packages/contracts` first, which is
 *     that package's commit, not this one.
 *   - **context switches *per minute*.** The contract's `contextSwitches` is a
 *     count over the window. The rate is `contextSwitches / (windowMs / 60_000)`
 *     for any reader that wants it, and inventing a second field for the same
 *     fact is how two numbers start disagreeing.
 */

/**
 * How many projected signals a session keeps. 3000 is ~50 minutes of a desktop
 * sampling every second, or hours at the 5–15 s cadence the native sampler
 * actually uses — far past the 60 s window, and a hard ceiling either way.
 *
 * Projection is the point: a stored signal is a handful of strings and numbers,
 * never the payload that arrived. See `project`.
 */
export const SIGNAL_RING_LIMIT = 3_000

/**
 * §7 / `DEFAULT_POLICY`. Used when a session has no goal, or the goal's policy
 * predates the field. The session's own `Policy.windowMs` wins whenever it is
 * readable, so a goal that asks for a 5-minute window gets one.
 */
export const DEFAULT_WINDOW_MS = 60_000

/** A page or window title is a label, not a document. Cap it before storing. */
const MAX_TITLE_CHARS = 160

/**
 * How long the last known state may keep being credited after the last signal we
 * received. The desktop samples every few seconds; a minute of silence means it
 * stopped talking (app quit, laptop asleep, lid closed) and we do not invent
 * focus time for a machine nobody is watching.
 */
const TAIL_CAP_MS = 60_000

/**
 * How long a session's goal facts are trusted before the goal is re-read. The
 * goal changes rarely, and this is a database read on a path that can be hit
 * several times a second.
 */
const FACTS_TTL_MS = 60_000

/** A gap this long between two on-task stretches ends the focus run. */
const RUN_GAP_MS = 5_000

/** `inputRate` is events per 30 s (§2), so the window is normalised to it. */
const INPUT_WINDOW_MS = 30_000

/** The contract caps both lists at 8. */
const TOP_N = 8

/* ---- what is kept -------------------------------------------------------- */

/**
 * One stored signal: the projection of a contract `Signal` down to the fields
 * the fold can actually use.
 *
 * The contract's `payload` is an open record and is deliberately dropped here.
 * Keeping it would mean keeping whatever a client decided to send — titles,
 * urls, and in the worst case text typed into a field — in memory for the whole
 * session, which is exactly the retention this service is not allowed to have.
 * What survives is what the window is made of: which app, which site, how long,
 * how much input, whether it was idle.
 */
export interface StoredSignal {
  source: SignalSource
  kind: string
  /** ISO-8601, as it arrived. */
  ts: string
  /** Foreground app, as the desktop named it. Matched case-insensitively. */
  app: string | null
  /** Normalised host (`www.` and path stripped), matched against the goal. */
  site: string | null
  /** Window/tab title, capped at `MAX_TITLE_CHARS`. */
  title: string | null
  /** An explicit dwell for this signal, in seconds, when the client sent one. */
  seconds: number | null
  /** Input events this signal accounts for (from `count`/`events`/`keys`/`rate`). */
  inputEvents: number | null
  /** `idle.state`-style flag. */
  idle: boolean | null
  /** `focus.state`-style flag: the OS focus/DND mode. */
  focus: boolean | null
  /** A key into the object store for a screen artifact — a ref, never bytes. */
  ref: string | null
}

/**
 * `https://www.youtube.com/watch?v=…`, `www.youtube.com`, `youtube.com/x` and
 * `youtube.com` all have to match a goal that says `youtube.com`, or the goal
 * silently stops working depending on how the desktop phrased the url.
 */
const hostOf = (value: string | null): string | null => {
  if (value === null) return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return null

  let host: string
  try {
    host = new URL(trimmed).host
  } catch {
    // Not a url. Everything before the first path/query/fragment separator is
    // the closest thing to a host in what we were handed.
    host = trimmed.split(/[/?#]/)[0] ?? trimmed
  }

  host = host.replace(/:\d+$/, '')
  if (host.startsWith('www.')) host = host.slice(4)
  return host.length > 0 ? host : null
}

const readString = (payload: Signal['payload'], ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

const readNumber = (payload: Signal['payload'], ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

const readBoolean = (payload: Signal['payload'], ...keys: string[]): boolean | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

/**
 * The projection. Every field is read by *name*, not by `kind`, because `kind`
 * is an open vocabulary (`app.focus`, `window.title`, …) that a client is free
 * to extend, while the numbers the fold needs are unambiguous.
 *
 * Durations come in three shapes: `seconds`, `ms`, or nothing at all — the last
 * case meaning "until the next signal", which is how a sampler naturally
 * reports and what the interval walk below uses.
 */
const project = (signal: Signal): StoredSignal => {
  const { payload } = signal

  const title = readString(payload, 'title', 'windowTitle')
  const url = readString(payload, 'url', 'href')
  const ms = readNumber(payload, 'ms', 'durationMs')
  const seconds = readNumber(payload, 'seconds', 'durationSeconds') ?? (ms === null ? null : ms / 1000)
  const rate = readNumber(payload, 'rate')
  const events =
    readNumber(payload, 'count', 'events', 'keys', 'keystrokes') ??
    (rate === null ? null : rate * (INPUT_WINDOW_MS / 1000))

  return {
    source: signal.source,
    kind: signal.kind,
    ts: signal.ts,
    app: readString(payload, 'app', 'appName', 'bundleId'),
    site: hostOf(readString(payload, 'host', 'site', 'domain') ?? url),
    title: title === null ? null : title.slice(0, MAX_TITLE_CHARS),
    seconds: seconds !== null && seconds > 0 ? seconds : null,
    inputEvents: events,
    idle: readBoolean(payload, 'idle', 'idleState'),
    focus: readBoolean(payload, 'focusMode', 'enabled', 'focus'),
    ref: readString(payload, 'key', 'ref', 'screenRef', 'frameRef'),
  }
}

/* ---- the goal, and what "on task" means ---------------------------------- */

interface GoalFacts {
  windowMs: number
  allowedApps: Set<string>
  blockedApps: Set<string>
  allowedSites: Set<string>
  blockedSites: Set<string>
}

interface SessionFacts {
  goal: GoalFacts | null
  fetchedAt: number
}

/**
 * The goal's four lists live in `Json` columns that Prisma types as `JsonValue`,
 * so they have to be read as unknown data rather than trusted. A column holding
 * a string where a list is expected is a bug, not a crash: it is dropped, and an
 * app nobody described is *unknown* rather than off-task.
 */
const StringList = z.array(z.string())

const readList = (value: unknown): string[] => {
  const parsed = StringList.safeParse(value)
  return parsed.success ? parsed.data : []
}

const normaliseAll = (values: string[], clean: (value: string) => string | null): Set<string> => {
  const out = new Set<string>()
  for (const value of values) {
    const normalised = clean(value)
    if (normalised !== null) out.add(normalised)
  }
  return out
}

const normaliseApp = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * `Policy` is law, and it carries `windowMs` with a default of its own, so the
 * policy is parsed through the contract rather than hand-read: a goal whose
 * policy is `{}` (or missing a field added later) still yields a usable window.
 */
const goalFactsOf = (goal: {
  allowedApps: unknown
  blockedApps: unknown
  allowedSites: unknown
  blockedSites: unknown
  policy: unknown
}): GoalFacts => {
  const policy = Policy.safeParse(goal.policy)
  return {
    windowMs: policy.success ? policy.data.windowMs : DEFAULT_WINDOW_MS,
    allowedApps: normaliseAll(readList(goal.allowedApps), normaliseApp),
    blockedApps: normaliseAll(readList(goal.blockedApps), normaliseApp),
    allowedSites: normaliseAll(readList(goal.allowedSites), hostOf),
    blockedSites: normaliseAll(readList(goal.blockedSites), hostOf),
  }
}

/*
 * The facts cache exists because `getWindow` is synchronous — `GET /v1/sessions/
 * :id/window` answers a plain value, not a promise — while the goal is a
 * database read. It is refreshed by `ingestSignals`, which is already async, and
 * only ever after `FACTS_TTL_MS`, so a live desktop keeps it current while a
 * read-only probe still gets an answer.
 */
const facts = new Map<string, SessionFacts>()

const factsOf = (sessionId: string): SessionFacts | undefined => facts.get(sessionId)

async function loadFacts(sessionId: string): Promise<SessionFacts> {
  try {
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { goal: true },
    })
    // A session whose row is gone (or never existed) is not a reason to drop
    // signals: the desktop may be flushing a batch it collected offline against
    // a session this process has not seen. Everything is then *unknown* time.
    return { goal: row?.goal ? goalFactsOf(row.goal) : null, fetchedAt: Date.now() }
  } catch (error) {
    log.warn({ sessionId, err: error }, 'could not read the session goal; treating it as unknown')
    return { goal: null, fetchedAt: Date.now() }
  }
}

async function ensureFacts(sessionId: string): Promise<void> {
  const current = factsOf(sessionId)
  if (current && Date.now() - current.fetchedAt < FACTS_TTL_MS) return
  facts.set(sessionId, await loadFacts(sessionId))
}

type TaskClass = 'on' | 'off' | 'unknown'

/**
 * The judgement, in one place and with a stated precedence:
 *
 *   1. a blocked **site** wins — youtube.com is off-task even inside Safari,
 *      which the goal allows, because the person is on the site, not on the app;
 *   2. a blocked app;
 *   3. an allowed app;
 *   4. an allowed site;
 *   5. everything else is **unknown**, which is not off-task.
 *
 * §3 lists the four lists precisely because "allowed" is a whitelist the user
 * wrote. An app that appears in neither list was never described, and calling
 * that off-task is the kind of guess that ends up nagging someone about an app
 * they were told was fine.
 *
 * The goal's lists are normalised to lower case when they are read (a goal
 * written as `Code` and a desktop that reports `code` are the same app), so the
 * lookups are lower-cased too. The name kept for display is the one the desktop
 * sent.
 */
const classify = (app: string | null, site: string | null, goal: GoalFacts | null): TaskClass => {
  if (goal === null) return 'unknown'
  const appKey = app === null ? null : app.toLowerCase()
  if (site !== null && goal.blockedSites.has(site)) return 'off'
  if (appKey !== null && goal.blockedApps.has(appKey)) return 'off'
  if (appKey !== null && goal.allowedApps.has(appKey)) return 'on'
  if (site !== null && goal.allowedSites.has(site)) return 'on'
  return 'unknown'
}

/**
 * The app-level flag the contract's `topApps[].onTask` and `topSites[].onTask`
 * carry.
 *
 * The boolean has no third state, so an app that is neither allowed nor blocked
 * is reported as **not off-task** (`true`). Reporting it as `false` would turn
 * "nobody described this app" into an accusation, which is the opposite of what
 * `classify` decides; the window's `focusedSeconds` / `offTaskSeconds` are where
 * unknown time is excluded, and they are in the same object for anyone who needs
 * the distinction the boolean cannot hold.
 */
const appFlag = (name: string, goal: GoalFacts | null, kind: 'app' | 'site'): boolean => {
  if (goal === null) return true
  const blocked = kind === 'app' ? goal.blockedApps : goal.blockedSites
  return !blocked.has(name)
}

/* ---- the fold ------------------------------------------------------------ */

interface Point {
  ts: number
  app: string | null
  site: string | null
  title: string | null
  seconds: number | null
}

interface Segment {
  start: number
  end: number
  app: string | null
  site: string | null
  title: string | null
  cls: TaskClass
}

interface Interval {
  start: number
  end: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * Sources that describe what is in front of the person. `idle` and `input`
 * describe the person's state, not the screen, so they never move the app
 * timeline; `desk` is the camera and `system` is the machine's own flags.
 */
const FOCUS_SOURCES: readonly SignalSource[] = ['app', 'window', 'screen']

const isFocusSignal = (signal: StoredSignal): boolean =>
  FOCUS_SOURCES.includes(signal.source) &&
  (signal.app !== null || signal.site !== null || signal.title !== null)

/** The identity of a context: the app, and the site inside it. */
const contextKey = (app: string | null, site: string | null): string =>
  `${app ?? ''}|${site ?? ''}`

/**
 * Every focus signal in the ring, oldest first, as a state machine: each one
 * updates the fields it carries and leaves the rest where they were. A
 * `window.title` with a url and no app therefore keeps the app it is inside.
 */
function focusPoints(ring: readonly StoredSignal[], to: number): Point[] {
  const points: Point[] = []
  for (const signal of ring) {
    const ts = Date.parse(signal.ts)
    if (!Number.isFinite(ts)) continue
    if (ts > to) continue
    if (!isFocusSignal(signal)) continue
    points.push({
      ts,
      app: signal.app,
      site: signal.site,
      title: signal.title,
      seconds: signal.seconds,
    })
  }
  return points
}

/**
 * Turns the points into segments [start, end) that are contiguous by
 * construction, then clips them to the window.
 *
 * Attribution: a segment belongs to the state that was current when it started,
 * which is the state established by the *previous* point. A point that carries
 * its own `seconds` (a client that measured the dwell itself) ends its segment
 * there and lets the next state start at the next point, so an over-long
 * explicit duration can never overlap the segment after it.
 */
/**
 * The next state after a point: what the point carries wins, everything else is
 * inherited — except across an app change.
 *
 * A site belongs to the window it was seen in, so moving to another app drops
 * it: without that, a goal's blocked site would keep being credited (or blamed)
 * for a different application that merely followed it in the ring.
 *
 * A function rather than an object literal inline in the loop below, because the
 * loop's carried state and the literal would otherwise be inferred from each
 * other.
 */
const advance = (point: Point, previous: Point | null): Point => {
  const appChanged =
    point.app !== null &&
    (previous === null ||
      previous.app === null ||
      point.app.toLowerCase() !== previous.app.toLowerCase())

  return {
    ts: point.ts,
    app: point.app ?? previous?.app ?? null,
    site: point.site ?? (appChanged ? null : (previous?.site ?? null)),
    title: point.title ?? (appChanged ? null : (previous?.title ?? null)),
    seconds: point.seconds,
  }
}

function segmentsOf(
  points: readonly Point[],
  from: number,
  to: number,
  evidenceEnd: number,
  goal: GoalFacts | null,
): { segments: Segment[]; switches: number } {
  let state: Point | null = null
  const raw: Segment[] = []
  let switches = 0

  for (const point of points) {
    // The state as it stood *before* this point: the segment below belongs to
    // it, and this point is what ends it.
    const previous: Point | null = state

    if (previous !== null) {
      const explicitEnd = previous.seconds === null ? null : previous.ts + previous.seconds * 1000
      const end = explicitEnd === null ? point.ts : Math.min(explicitEnd, point.ts)
      raw.push({
        start: previous.ts,
        end,
        app: previous.app,
        site: previous.site,
        title: previous.title,
        cls: classify(previous.app, previous.site, goal),
      })
    }

    // A change of app or of site is a context switch. A repeated report of the
    // same app is not, and neither is a changing page title inside one site:
    // the person did not move, so counting it would inflate every busy minute.
    if (previous !== null && point.ts >= from && point.ts <= to) {
      const before = contextKey(previous.app, previous.site)
      const after = contextKey(point.app ?? previous.app, point.site ?? previous.site)
      if (before !== after) switches += 1
    }

    // A field this point does not carry keeps the value it had.
    state = advance(point, previous)
  }

  // The open tail: the last state holds until more evidence arrives, but only
  // for `TAIL_CAP_MS` past the last signal we hold — see the constant.
  if (state !== null) {
    const explicitEnd = state.seconds === null ? null : state.ts + state.seconds * 1000
    const end = evidenceEnd
    raw.push({
      start: state.ts,
      end: explicitEnd === null ? end : Math.min(explicitEnd, end),
      app: state.app,
      site: state.site,
      title: state.title,
      cls: classify(state.app, state.site, goal),
    })
  }

  const segments: Segment[] = []
  for (const segment of raw) {
    const start = Math.max(segment.start, from)
    const end = Math.min(segment.end, to)
    if (end - start <= 0) continue
    segments.push({ ...segment, start, end })
  }

  return { segments, switches }
}

/**
 * Idle intervals, from the three shapes the signals use:
 *
 *   - `idle.start` then `idle.end` — an interval between the two;
 *   - any idle signal carrying `seconds`/`ms` — an interval *ending* at its ts;
 *   - `idle.state` with `idle: true` / `idle: false` — the same as start/end.
 *
 * An interval still open at the end of the walk is credited up to
 * `evidenceEnd`: the last thing the machine said was "away", and that stays
 * true until it says otherwise — but not past the point where it stopped
 * talking at all.
 */
function idleIntervalsOf(ring: readonly StoredSignal[], from: number, to: number, evidenceEnd: number): Interval[] {
  const raw: Interval[] = []
  let openAt: number | null = null

  for (const signal of ring) {
    const ts = Date.parse(signal.ts)
    if (!Number.isFinite(ts) || ts > to) continue
    if (signal.source !== 'idle' && signal.idle === null) continue

    if (signal.seconds !== null) {
      raw.push({ start: ts - signal.seconds * 1000, end: ts })
    }

    const flag = signal.idle ?? (signal.kind.endsWith('.end') ? false : signal.kind.endsWith('.start') ? true : null)
    if (flag === true) {
      openAt ??= ts
    } else if (flag === false) {
      if (openAt !== null) raw.push({ start: openAt, end: ts })
      openAt = null
    }
  }

  if (openAt !== null) raw.push({ start: openAt, end: Math.min(to, evidenceEnd) })

  const clipped = raw
    .map((interval) => ({ start: Math.max(interval.start, from), end: Math.min(interval.end, to) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start)

  // Merge: `idle.start`/`idle.end` pairs and explicit durations describe the
  // same absence twice often enough that counting them unmerged would report
  // more idle time than the window has in it.
  const merged: Interval[] = []
  for (const interval of clipped) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

/** Seconds of `[start, end)` covered by the merged intervals. */
const idleSecondsIn = (intervals: readonly Interval[], start: number, end: number): number => {
  let total = 0
  for (const interval of intervals) {
    if (interval.end <= start) continue
    if (interval.start >= end) break
    total += Math.min(interval.end, end) - Math.max(interval.start, start)
  }
  return total / 1000
}

/**
 * The window itself: pure, synchronous, and derived from the ring plus the
 * goal — no clock is read here that the caller did not hand in, which is what
 * makes it testable against a fixed `now`.
 */
function computeWindow(sessionId: string, now: number): SignalWindowContract | null {
  const state = sessions.get(sessionId)
  const ring = state?.ring
  if (ring === undefined || ring.length === 0) return null

  const goal = factsOf(sessionId)?.goal ?? null
  const windowMs = goal?.windowMs ?? DEFAULT_WINDOW_MS
  const to = now
  const from = now - windowMs

  // The newest thing we hold bounds how far any judgement of "still there" may
  // run. Ignoring it is how a dead desktop ends up credited with an hour of
  // focus. See TAIL_CAP_MS.
  const newest = ring[ring.length - 1]
  const newestTs = newest === undefined ? to : Date.parse(newest.ts)
  const evidenceEnd = Math.min(to, (Number.isFinite(newestTs) ? newestTs : to) + TAIL_CAP_MS)

  const points = focusPoints(ring, to)
  const { segments, switches } = segmentsOf(points, from, to, evidenceEnd, goal)
  const idle = idleIntervalsOf(ring, from, to, evidenceEnd)

  let focused = 0
  let offTask = 0
  let idleSeconds = 0
  for (const interval of idle) idleSeconds += (interval.end - interval.start) / 1000

  const appSeconds = new Map<string, number>()
  /**
   * Time per **site**, keyed by host. A window title with no url is not a site
   * — it is the title of an app's window, and a document title is not somewhere
   * the person went. topApps already accounts for that time, so the two lists
   * stay about two different things.
   */
  const siteSeconds = new Map<string, number>()

  let run = 0
  let longestRun = 0
  let previousEnd: number | null = null

  for (const segment of segments) {
    const seconds = (segment.end - segment.start) / 1000
    const idleInside = idleSecondsIn(idle, segment.start, segment.end)
    // Idle is carved out of the classification rather than added to it: a
    // machine reporting "away" while the editor is frontmost is not 60 s of
    // focus, and counting it in both buckets would sum past the window.
    const active = Math.max(0, seconds - idleInside)

    if (segment.cls === 'on') focused += active
    else if (segment.cls === 'off') offTask += active

    if (segment.app !== null) {
      appSeconds.set(segment.app, (appSeconds.get(segment.app) ?? 0) + seconds)
    }
    const siteKey = segment.site
    if (siteKey !== null) {
      siteSeconds.set(siteKey, (siteSeconds.get(siteKey) ?? 0) + seconds)
    }

    if (segment.cls === 'on' && active > 0) {
      // A run continues while the next stretch is on-task and starts where the
      // previous one ended: any other class, or a hole in the evidence, ends it.
      const contiguous = previousEnd !== null && segment.start - previousEnd <= RUN_GAP_MS
      run = contiguous ? run + active : active
      longestRun = Math.max(longestRun, run)
    } else {
      run = 0
    }
    previousEnd = segment.end
  }

  /* -- input rate, events per 30 s, never content ------------------------- */
  let inputEvents = 0
  for (const signal of ring) {
    const ts = Date.parse(signal.ts)
    if (!Number.isFinite(ts) || ts < from || ts > to) continue
    if (signal.inputEvents === null) continue
    inputEvents += signal.inputEvents
  }
  const inputRate = (inputEvents / windowMs) * INPUT_WINDOW_MS

  /* -- the goal flags the console shows ----------------------------------- */
  const topApps = [...appSeconds.entries()]
    .map(([app, seconds]) => ({
      app,
      seconds: round1(seconds),
      onTask: appFlag(app.toLowerCase(), goal, 'app'),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.app.localeCompare(b.app))
    .slice(0, TOP_N)

  const topSites = [...siteSeconds.entries()]
    .map(([host, seconds]) => ({
      title: host,
      seconds: round1(seconds),
      onTask: appFlag(host, goal, 'site'),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title))
    .slice(0, TOP_N)

  /* -- the latest system focus flag --------------------------------------- */
  let focusMode = false
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    const signal = ring[index]
    if (signal === undefined) continue
    if (signal.source !== 'system' || signal.focus === null) continue
    focusMode = signal.focus
    break
  }

  /* -- the newest screen artifact ----------------------------------------- */
  let lastScreenRef: string | null = null
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    const signal = ring[index]
    if (signal === undefined) continue
    if (signal.source !== 'screen' && signal.source !== 'window') continue
    if (signal.ref === null) continue
    lastScreenRef = signal.ref
    break
  }

  /*
   * `onTaskRatio` is a judgement about the goal, so its denominator is the time
   * a judgement was possible: focused + off-task. Idle and unknown time are in
   * neither the numerator nor the denominator — a person who stepped away, and
   * an app the goal never described, both land here, and neither is evidence of
   * distraction. A window with nothing judgeable in it reports 1: nothing we
   * observed was off the goal, and `focusedSeconds + offTaskSeconds = 0` is the
   * honest signal that this window holds no judgement at all.
   *
   * Computing it against the whole window instead would read idle as drift,
   * which is the fastest way to nag someone who went to make tea.
   */
  const judged = focused + offTask
  const onTaskRatio = judged > 0 ? clamp01(focused / judged) : 1

  const window: SignalWindowContract = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    windowMs,
    focusedSeconds: round1(focused),
    offTaskSeconds: round1(offTask),
    idleSeconds: round1(idleSeconds),
    contextSwitches: switches,
    longestFocusRunSeconds: round1(longestRun),
    inputRate: round1(inputRate),
    onTaskRatio: Math.round(onTaskRatio * 1000) / 1000,
    topApps,
    topSites,
    focusMode,
    lastFrameRef: latestFrameRef(sessionId)?.key ?? null,
    lastScreenRef,
  }

  // The contract is law and this object is published on a channel no serializer
  // guards (the SSE route writes `JSON.stringify(event.data)` straight out), so
  // it is validated here once. A failure is a bug in this file, not a client
  // error: it is logged loudly and nothing is published, rather than letting a
  // NaN or a 9-element list reach the model and the policy.
  const validated = SignalWindow.safeParse(window)
  if (!validated.success) {
    log.error({ sessionId, issues: validated.error.issues }, 'computed an invalid SignalWindow')
    return null
  }
  return validated.data
}

/* ---- state --------------------------------------------------------------- */

interface SignalSessionState {
  /** Projected signals, oldest first, capped at `SIGNAL_RING_LIMIT`. */
  ring: StoredSignal[]
  /**
   * Every signal ever accepted for this session, monotonic. The ring is a
   * sliding view and would saturate; a session roll-up that asked it "how many
   * signals were there" would get 3000 for an afternoon's work.
   */
  total: number
}

const sessions = new Map<string, SignalSessionState>()

/** `deviceId → sessionId`, from a `hello` or from any batch that named one. */
const bindings = new Map<string, string>()

/** Accepted signals that had no session to fold into. Diagnostics only. */
const unbound = new Map<string, number>()

const stateFor = (sessionId: string): SignalSessionState => {
  let state = sessions.get(sessionId)
  if (state === undefined) {
    state = { ring: [], total: 0 }
    sessions.set(sessionId, state)
  }
  return state
}

/**
 * Bounded push. Out-of-order timestamps are the exception (a client that
 * batched offline and flushed in the wrong order), so the ring is only re-sorted
 * when one actually arrives: the fold walks the ring in order and a signal in
 * the wrong place would move a segment's boundary.
 */
const pushSignal = (ring: StoredSignal[], signal: StoredSignal): void => {
  const last = ring[ring.length - 1]
  ring.push(signal)
  if (last !== undefined && signal.ts < last.ts) {
    // Re-sorted only when the ring actually went backwards; the common case is
    // a batch that arrives in order, and sorting 3000 entries per signal would
    // be work for nothing.
    ring.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  }
  if (ring.length > SIGNAL_RING_LIMIT) ring.splice(0, ring.length - SIGNAL_RING_LIMIT)
}

/* ---- intake -------------------------------------------------------------- */

/**
 * The newest still-open session for a device, read straight from the database.
 *
 * Deliberately not `services/session.ts`: that file belongs to the session
 * lifecycle row, and a signal path that imported it would couple the desktop's
 * intake to whatever that file decides next. One indexed read is the whole
 * dependency.
 */
async function newestOpenSession(deviceId: string): Promise<string | null> {
  try {
    const row = await prisma.session.findFirst({
      where: { deviceId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    })
    return row?.id ?? null
  } catch (error) {
    log.warn({ deviceId, err: error }, 'could not look up an open session for the device')
    return null
  }
}

/**
 * Stores, folds and publishes one batch of desktop signals.
 *
 * `sessionId` may be null: the desktop is allowed to talk about the machine
 * before (or after) it knows which session it belongs to — a batch collected
 * offline is flushed on the next boot, when the session may already be gone. In
 * that case the session is resolved in order:
 *
 *   1. the newest session for the device that is **still open** (`endedAt: null`),
 *      straight from the database;
 *   2. the session this device bound to with a socket `hello` — a *fallback*,
 *      not an override, because a session the user closed must not keep
 *      collecting live signals just because a socket remembered it;
 *   3. nothing — the batch is **accepted and counted**, and no window is
 *      produced, because a window has to belong to a session.
 *
 * Counted-and-dropped is the intended failure mode: the desktop's ack must not
 * depend on the server's idea of which session is open, or a flush after a
 * restart would fail forever.
 */
export async function ingestSignals(
  deviceId: string,
  sessionId: string | null,
  signals: Signal[],
): Promise<{ accepted: number }> {
  const accepted = signals.length
  if (accepted === 0) return { accepted }

  let target = sessionId
  if (target === null) target = await newestOpenSession(deviceId)
  if (target === null) target = bindings.get(deviceId) ?? null

  if (target === null) {
    unbound.set(deviceId, (unbound.get(deviceId) ?? 0) + accepted)
    log.info(
      { deviceId, accepted, unbound: unbound.get(deviceId) },
      'signals accepted with no open session to fold them into',
    )
    return { accepted }
  }

  // A batch that names its session is the plainest statement of the binding
  // there is, so it is remembered for the next one that does not.
  bindings.set(deviceId, target)

  const state = stateFor(target)
  for (const signal of signals) pushSignal(state.ring, project(signal))
  state.total += accepted

  await ensureFacts(target)

  const window = computeWindow(target, Date.now())
  if (window !== null) {
    // Required by the P1 exit criteria: a live SSE subscriber sees window
    // updates. The SSE route forwards what is published and computes nothing,
    // so an unpublished window is an invisible one.
    publish(target, { event: 'signal.window', data: window })
    log.debug(
      { sessionId: target, deviceId, accepted, focused: window.focusedSeconds, offTask: window.offTaskSeconds },
      'signal window recomputed',
    )
  }

  return { accepted }
}

/**
 * Every signal accepted for a session. Monotonic: it keeps counting after the
 * ring has started evicting, which is what a session roll-up wants.
 */
export const countSignals = (sessionId: string): number => sessions.get(sessionId)?.total ?? 0

/**
 * Binds a device to a session without sending signals — what a desktop socket's
 * `hello` does. `hello` may carry either id as null; only the pair is useful.
 */
export function bindSession(deviceId: string, sessionId: string): void {
  bindings.set(deviceId, sessionId)
}

/**
 * The latest window for a session, recomputed from the ring at the moment it is
 * asked for.
 *
 * Recomputed, not cached: a cached window would keep its `to` from minutes ago
 * and a caller reading `focusedSeconds` off it would be reading history while
 * believing it read now. The fold is a walk over a bounded ring, and the goal is
 * cached separately, so this stays cheap and synchronous.
 *
 * `null` means "this session has produced no signals in this process" — there is
 * no window to show, as opposed to a window of zeros.
 */
export function getWindow(sessionId: string): SignalWindowContract | null {
  return computeWindow(sessionId, Date.now())
}

/**
 * The stored signals themselves, oldest first, capped at the last `limit`.
 * Projected: counts and titles, never payload bodies.
 */
export const listSignals = (sessionId: string, limit = SIGNAL_RING_LIMIT): StoredSignal[] => {
  const ring = sessions.get(sessionId)?.ring ?? []
  return ring.slice(Math.max(0, ring.length - Math.max(0, limit)))
}

/**
 * A session is over: its ring, its bindings and its goal facts go.
 *
 * Called when the session is closed, **not** when a socket disconnects — a
 * desktop that closes its lid has not ended the session, and dropping the ring
 * on every disconnect would give the next window an empty history.
 */
export function endSignalSession(sessionId: string): void {
  sessions.delete(sessionId)
  facts.delete(sessionId)
  for (const [deviceId, bound] of bindings) {
    if (bound === sessionId) bindings.delete(deviceId)
  }
}

/** Drops every in-memory signal structure. Probes and tests. */
export function resetSignals(): void {
  sessions.clear()
  bindings.clear()
  facts.clear()
  unbound.clear()
}
