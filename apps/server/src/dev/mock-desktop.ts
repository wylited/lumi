/**
 * The mock desktop — a fake `apps/desktop` for people who have no Mac, no macOS
 * permissions and no Tauri build, which is every server and web developer and
 * half the demos.
 *
 * `docs/phases/P1-server-core.md#HELI-017` asks it to "replay a plausible work
 * pattern — 6 minutes in the editor, then a tab switch to a distracting site for
 * 40 s, then back — as real signals at real timings".
 *
 * Three things make it a replay rather than an invention:
 *
 *   - **The numbers come from `apps/server/fixtures/windows/*.json`.** Those
 *     twelve files (and the twelve real JPEGs beside them) are the ones
 *     `fixtures/expected.json` describes, so the mock reads them at runtime
 *     instead of synthesising a second, different set of scenarios. A signal
 *     timeline is a fold over a fixture window's own `focusedSeconds`,
 *     `offTaskSeconds`, `idleSeconds`, `inputRate`, `focusMode`, `topApps` and
 *     `topSites`.
 *   - **The vocabulary is the desktop's own.** `apps/desktop/src-tauri/src/
 *     signals/` is the real producer: `app.frontmost`, `window.title`,
 *     `input.rate`, `idle.state`. Every payload key below is one the Rust
 *     sampler really sends, because `services/signals.ts#project` reads payload
 *     *fields* by name and a mock that invented its own dialect would produce a
 *     window that means nothing.
 *   - **The transports are the real ones.** The first batch goes over
 *     `POST /v1/signals` — the "flushed while offline" path that route exists
 *     for — and every batch after it over `/ws/desktop` with
 *     `Sec-WebSocket-Protocol: heli.v1, <userToken>`. Both land in the same
 *     `ingestSignals` call, so one run exercises both without a second code path.
 *
 * This module also owns the scenario registry and the fixture reader, because
 * the desktop replay is what consumes most of them: `mock-device.ts` is the
 * entry point the `dev:mock` script runs and imports both from here.
 *
 * Run it alone with `node --import tsx src/dev/mock-desktop.ts`, or through the
 * entry point, which drives both fakes.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ApiToDesktop, DesktopToApi, HELI_SOCKET_PROTOCOL, Signal, SignalBatch } from '@heli/contracts'
import type { Device, Goal, Signal as SignalContract, SignalWindow } from '@heli/contracts'
import type { Logger } from 'pino'

import { childLogger } from '../logger.js'

/* ---- where the fixtures are ---------------------------------------------- */

/**
 * `src/dev/` → `apps/server/fixtures/`. Resolved from this module rather than
 * from `process.cwd()`, so the mock works from the package, from the repo root
 * and from a test.
 */
const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url))

/** One `fixtures/windows/*.json`: a `SignalWindow` plus the two fields the fixture adds. */
export interface FixtureWindowFile {
  id: string
  note: string
  /** The contract's own shape — never re-declared here (AGENTS.md: contracts are law). */
  window: SignalWindow
  goalKind: string
}

export async function readFixtureWindow(id: string): Promise<FixtureWindowFile> {
  const path = join(FIXTURES_DIR, 'windows', `${id}.json`)
  return JSON.parse(await readFile(path, 'utf8')) as FixtureWindowFile
}

/** The bytes of one real JPEG from `fixtures/frames`. Sent unmodified. */
export async function readFixtureFrame(id: string): Promise<Buffer> {
  return readFile(join(FIXTURES_DIR, 'frames', `${id}.jpg`))
}

/* ---- the scenarios -------------------------------------------------------- */

export type ScenarioName = 'focused' | 'drifting' | 'phone'

export const SCENARIO_NAMES: readonly ScenarioName[] = ['focused', 'drifting', 'phone']

export const isScenarioName = (value: string): value is ScenarioName =>
  (SCENARIO_NAMES as readonly string[]).includes(value)

export interface ScenarioFrame {
  /** A file in `fixtures/frames` (without `.jpg`). */
  id: string
  /** §2's `frame.trigger` — the device's own word for what changed. The vocabulary is open. */
  trigger: string
}

export interface Scenario {
  name: ScenarioName
  /** One line, for `--help`, the boot log and the report. */
  summary: string
  /**
   * Fixture windows replayed in order. The desktop's timeline is built from
   * these; the device sends the frames below.
   */
  windows: readonly string[]
  /** Four real frames, in the order they are sent. */
  frames: readonly ScenarioFrame[]
}

/**
 * The three `--scenario` values the phase doc names, mapped onto fixtures that
 * exist.
 *
 * `drifting` is the phase doc's own work pattern — the editor, then a tab
 * switch, then back — spelled with three windows: `focused-desk-10m` (the
 * editor stretch), `off-task-social-40s` and `off-task-video-90s` (two
 * consecutive off-goal windows, which is what `expectedTier: 2` needs), and
 * `recovery-after-nudge` (back on task, and the only fixture that sets
 * `focusMode: true`).
 *
 * Deviation, deliberately: the phase doc says "6 minutes in the editor" and no
 * fixture is 6 minutes long — `focused-desk-10m` is ten, `focus-run-2m` is two.
 * The fixture wins, because the brief for this row is that the fixtures *are*
 * the scenarios and `expected.json` describes them.
 */
export const SCENARIOS: Record<ScenarioName, Scenario> = {
  focused: {
    name: 'focused',
    summary: 'ten minutes at the desk with the editor frontmost, and nothing to interrupt',
    windows: ['focused-desk-10m'],
    frames: [
      { id: 'focused-desk-10m', trigger: 'pen_still' },
      { id: 'focus-run-2m', trigger: 'page_turn' },
      { id: 'long-focus-12m', trigger: 'still_hold' },
      { id: 'reading-low-input', trigger: 'reading_still' },
    ],
  },
  drifting: {
    name: 'drifting',
    summary: 'the editor, then a social feed and a video, then back on task',
    windows: [
      'focused-desk-10m',
      'off-task-social-40s',
      'off-task-video-90s',
      'recovery-after-nudge',
    ],
    frames: [
      { id: 'focused-desk-10m', trigger: 'pen_still' },
      { id: 'off-task-social-40s', trigger: 'tab_switch' },
      { id: 'off-task-video-90s', trigger: 'video_playing' },
      { id: 'recovery-after-nudge', trigger: 'back_at_desk' },
    ],
  },
  phone: {
    name: 'phone',
    summary: 'a phone in hand: a feed and then a video, with almost no input',
    windows: ['phone-in-hand', 'off-task-video-90s'],
    frames: [
      { id: 'phone-in-hand', trigger: 'phone_raised' },
      { id: 'off-task-video-90s', trigger: 'video_playing' },
      { id: 'second-person', trigger: 'second_person' },
      { id: 'away-idle', trigger: 'still_hold' },
    ],
  },
}

/* ---- the seeded goal is what decides on-task ------------------------------ */

/**
 * A fixture's `topSites[].title` is a display **label** ("Video site", "Social
 * feed", "Feed"), not a host — and `services/signals.ts` decides off-task time
 * by *host* against the goal's `blockedSites`. A literal replay therefore
 * classifies every distraction as `unknown`: the seeded goal has
 * `allowedApps: [Code, Safari, Notes, Calculator]` and
 * `blockedSites: [youtube.com, twitter.com, x.com, reddit.com]`, and no label
 * matches any of them.
 *
 * So each label is mapped onto the seeded goal's blocked site of the same kind.
 * This is the one place the mock adds information the fixtures do not carry, it
 * is one four-line table, and it is what makes the window's numbers land on the
 * ones `expected.json` describes instead of reporting a session of pure
 * `unknown` time. A label missing from this table keeps its app and no site,
 * which the fold reads as `unknown` — the honest answer for "a site we were not
 * told about", and a warning is logged when it happens.
 */
const SITE_FOR_LABEL: Record<string, string> = {
  'Video site': 'youtube.com',
  'Social feed': 'reddit.com',
  Feed: 'twitter.com',
}

/** Display name → bundle id, the second of the two fields `app.frontmost` carries. */
const BUNDLE_IDS: Record<string, string> = {
  Code: 'com.microsoft.VSCode',
  Safari: 'com.apple.Safari',
  Notes: 'com.apple.Notes',
  Calculator: 'com.apple.calculator',
  Instagram: 'com.burbn.instagram',
  Discord: 'com.hnc.Discord',
  Slack: 'com.tinyspeck.slackmacgap',
}

const bundleIdOf = (app: string): string =>
  BUNDLE_IDS[app] ?? `com.heli.mock.${app.toLowerCase().replace(/[^a-z0-9]+/g, '')}`

/* ---- the timeline --------------------------------------------------------- */

/**
 * One stretch of one app, derived from a fixture window.
 *
 * `seconds` is the stretch's own duration in **scenario** seconds; the runner
 * divides it by `--speed` to get the wall clock it waits for, and the same
 * division is what the signal's dwell payload says, so the fold credits a
 * compressed timeline as compressed.
 */
interface Segment {
  app: string
  site: string | null
  title: string
  seconds: number
  /** Seconds of `idle` inside the segment, credited (and carved out) by the fold. */
  idleSeconds: number
  /** The fixture window's own `inputRate`, replayed as disjoint per-second counts. */
  inputRate: number
  /** The fixture window's `focusMode`, replayed as a `system` signal. */
  focusMode: boolean
}

/**
 * The fold over one fixture window.
 *
 * Durations come from the window's headline numbers — `focusedSeconds` and
 * `offTaskSeconds` — and the names come from `topApps` / `topSites`, because
 * those are two halves of the same statement: the fixture says *how long* and
 * *what*. A stretch the fixture cannot attribute is skipped with a warning
 * rather than invented.
 */
function segmentsOfFixture(file: FixtureWindowFile, log: Logger): Segment[] {
  const { window: w } = file
  const onTask = w.topApps.find((entry) => entry.onTask)
  const offTask = w.topApps.find((entry) => !entry.onTask)
  const offSite = w.topSites.find((entry) => !entry.onTask)
  const segments: Segment[] = []

  if (onTask !== undefined) {
    /**
     * `idleSeconds` is replayed only when the fixture's own arithmetic allows
     * it — `focusedSeconds - idleSeconds` has to come out as the on-task app's
     * seconds, which is the reading `focusedSeconds` is built on (a person at
     * the desk, 45 s of it away). Where it does not add up
     * (`recovery-after-nudge`: 110 - 20 ≠ 105) the idle is skipped, because
     * placing it would contradict another number in the same file.
     */
    const reconciles = Math.abs(w.focusedSeconds - w.idleSeconds - onTask.seconds) <= 1
    const idleSeconds = reconciles ? w.idleSeconds : 0
    if (!reconciles && w.idleSeconds > 0) {
      log.warn(
        {
          fixture: file.id,
          focusedSeconds: w.focusedSeconds,
          idleSeconds: w.idleSeconds,
          appSeconds: onTask.seconds,
        },
        'fixture idleSeconds does not fit its own focused/app split; not replayed',
      )
    }
    segments.push({
      app: onTask.app,
      site: null,
      title: `${onTask.app} window`,
      seconds: w.focusedSeconds,
      idleSeconds,
      inputRate: w.inputRate,
      focusMode: w.focusMode,
    })
  } else if (w.focusedSeconds > 0) {
    log.warn(
      { fixture: file.id, focusedSeconds: w.focusedSeconds },
      'fixture reports focused time with no on-task app in topApps; nothing to attribute it to',
    )
  }

  if (offTask !== undefined) {
    const label = offSite?.title ?? ''
    const site = SITE_FOR_LABEL[label] ?? null
    if (offSite !== undefined && site === null) {
      log.warn(
        { fixture: file.id, label },
        'fixture topSites label has no mapping onto the goal blocklist; that stretch will read as unknown time',
      )
    }
    segments.push({
      app: offTask.app,
      site,
      // The fixture's label is a window title, which is exactly what
      // `window.title` carries. The host, when we know one, rides in `site`.
      title: label.length > 0 ? label : `${offTask.app} window`,
      seconds: w.offTaskSeconds,
      idleSeconds: 0,
      inputRate: w.inputRate,
      focusMode: w.focusMode,
    })
  } else if (w.offTaskSeconds > 0) {
    log.warn(
      { fixture: file.id, offTaskSeconds: w.offTaskSeconds },
      'fixture reports off-task time with no off-task app in topApps; nothing to attribute it to',
    )
  }

  return segments
}

/* ---- signals, in the desktop's own dialect -------------------------------- */

/**
 * `app.frontmost` — source `app`, the real payload keys.
 *
 * `app` is included **as well as** `bundleId`, and that is a judgement call
 * worth stating: `services/signals.ts#project` reads `app | appName | bundleId`
 * in that order, while the Rust sampler sends `bundleId`
 * (`com.microsoft.VSCode`) and `name` — and the seeded goal's `allowedApps` are
 * display names (`Code`). A mock that copied the sampler byte for byte would
 * have every minute classified `unknown` and produce no focused time at all, so
 * it names the app the way the goal names it and keeps the real keys beside it.
 * The mismatch itself is a real one between the desktop's sampler and the signal
 * fold, not a quirk of this mock; it is in the row report.
 */
const appFrontmost = (segment: Segment, ts: string, pid: number): SignalContract => ({
  source: 'app',
  kind: 'app.frontmost',
  ts,
  confidence: 1,
  payload: {
    app: segment.app,
    name: segment.app,
    bundleId: bundleIdOf(segment.app),
    pid,
  },
})

/**
 * `window.title` — and the carrier of the segment's dwell.
 *
 * The window is *derived, never sent*: `services/signals.ts` reads
 * `seconds`/`durationSeconds`/`ms` from a signal as "how long that state
 * lasted", so the dwell rides on the second signal of each segment and the
 * fold's segments come out exactly as long as the fixture says. Rediscovering
 * durations from arrival times would make every number depend on scheduling
 * jitter.
 */
const windowTitle = (
  segment: Segment,
  dwellSeconds: number,
  ts: string,
): SignalContract => ({
  source: 'window',
  kind: 'window.title',
  ts,
  confidence: segment.site === null ? 0.9 : 0.5,
  payload: {
    title: segment.title,
    owner: segment.app,
    seconds: Math.round(dwellSeconds * 1000) / 1000,
    ...(segment.site === null ? {} : { site: segment.site }),
  },
})

/**
 * `idle.state` — the real dialect: `state` is the *new* state and `seconds` is
 * how long the previous one lasted. The fold credits `[ts - seconds, ts]`, so a
 * stretch of idle is reported when it ends ("was away 45 s, now active") and an
 * idle that never ends is worth nothing until it does — which is why the mock
 * sends the pair and not just the start. The real thresholds are 15 s and 120 s
 * (`signals/input.rs#Idle`), so a 45 s absence is `pause`.
 */
const idleState = (
  state: 'active' | 'pause' | 'away',
  seconds: number,
  ts: string,
): SignalContract => ({
  source: 'idle',
  kind: 'idle.state',
  ts,
  confidence: 1,
  payload: { state, seconds: Math.round(seconds * 1000) / 1000 },
})

/**
 * `input.rate`. The real sampler emits a **rolling 30 s** rate every 5 s, and
 * `services/signals.ts` sums `events` across signals — so the same 30 s of
 * typing is counted up to six times over and `SignalWindow.inputRate` reads
 * several times the truth. The mock sends **disjoint one-second counts** under
 * the same keys, which is the arithmetic that fold is written for: `inputRate`
 * then reads the fixture's own `inputRate`, scaled only by how much of the 60 s
 * window the replay actually covered.
 */
const inputRate = (segment: Segment, events: number, ts: string, pid: number): SignalContract => {
  const keys = Math.round(events * 0.85)
  const clicks = events - keys
  const keysPer30s = segment.inputRate * 0.85
  return {
    source: 'input',
    kind: 'input.rate',
    ts,
    confidence: 1,
    payload: {
      windowSeconds: 1,
      keys,
      clicks,
      events,
      burst: keysPer30s / 6 >= 20,
      activity: keysPer30s >= 20 ? 'typing' : segment.inputRate > 0 ? 'light' : 'still',
      pid,
    },
  }
}

/**
 * `system` with `focusMode` — the only source the fold reads for
 * `SignalWindow.focusMode` (see the backwards walk over the ring in
 * `services/signals.ts` looking for `source === 'system'` and a `focus`
 * boolean).
 *
 * Nothing in `apps/desktop/src-tauri` emits a `system` signal today, so
 * `focusMode` is `false` for every real session. The mock sends it for the
 * fixtures that set `focusMode: true` (`recovery-after-nudge`), so the field is
 * exercised rather than permanently dark.
 */
const focusMode = (enabled: boolean, ts: string): SignalContract => ({
  source: 'system',
  kind: 'focus.mode',
  ts,
  confidence: 1,
  payload: { focusMode: enabled, enabled },
})

/* ---- the schedule --------------------------------------------------------- */

interface Step {
  /** Wall-clock ms from the start of the replay. */
  atMs: number
  signals: SignalContract[]
}

/**
 * How often `input.rate` is emitted, in **wall** time.
 *
 * A rate is per second of wall clock, so compressing the *timeline* under
 * `--speed` must not compress the rate: someone typing 110 events per 30 s
 * types 3.67 per second whether the demo replays those 30 s in 30 s or in one.
 * Durations (`seconds`, and every `ts`) divide by `--speed`; rates do not. One
 * second is the cadence that makes that true per signal, and it is what the
 * native sampler would emit if it reported disjoint windows.
 */
const INPUT_CADENCE_MS = 1_000

/**
 * The whole replay, as a list of (wall offset, signals).
 *
 * Built in scenario seconds and divided by `speed` in one place, so `--speed`
 * cannot make the *contents* of the timeline disagree with the clock it is
 * delivered on: a signal's `ts` is its delivery time, and its `seconds` dwell is
 * the compressed duration the fold will credit.
 */
function stepsOf(segments: readonly Segment[], startedAt: number, speed: number): Step[] {
  const steps: Step[] = []
  let wallMs = 0
  let pid = 1_000

  for (const segment of segments) {
    const durationMs = (segment.seconds * 1000) / speed
    const dwellSeconds = segment.seconds / speed
    const tsAt = (offsetMs: number): string => new Date(startedAt + wallMs + offsetMs).toISOString()

    pid += 1
    steps.push({ atMs: wallMs, signals: [appFrontmost(segment, tsAt(0), pid)] })
    /**
     * 1 ms later, so the app point establishes the state and the title point
     * carries the dwell. Two points at the same instant have no order the fold
     * can use, and the 1 ms app-only slice classifies as `unknown` — a
     * millisecond of time nobody claims, which is the honest reading of two
     * samples arriving together.
     */
    steps.push({ atMs: wallMs + 1, signals: [windowTitle(segment, dwellSeconds, tsAt(1))] })

    if (segment.idleSeconds > 0) {
      const idleSeconds = segment.idleSeconds / speed
      const idleAt = Math.max(1, durationMs - idleSeconds * 1000)
      steps.push({ atMs: wallMs + idleAt, signals: [idleState('pause', 0, tsAt(idleAt))] })
      steps.push({
        atMs: wallMs + durationMs,
        signals: [idleState('active', idleSeconds, tsAt(durationMs))],
      })
    }

    if (segment.focusMode) {
      steps.push({ atMs: wallMs + 1, signals: [focusMode(true, tsAt(1))] })
    }

    /**
     * Disjoint per-second counts, accumulated as a float so the rounding cannot
     * drift: 110 events per 30 s is 3.67 per second, which is 4, 4, 3, 4, 4, 3…
     * rather than 4 every second (a 9 % lie).
     */
    const perSecond = segment.inputRate / 30
    let pending = 0
    for (let offset = INPUT_CADENCE_MS; offset <= durationMs; offset += INPUT_CADENCE_MS) {
      pending += perSecond
      const events = Math.round(pending)
      pending -= events
      pid += 1
      steps.push({ atMs: wallMs + offset, signals: [inputRate(segment, events, tsAt(offset), pid)] })
    }

    wallMs += durationMs
  }

  // Stable sort: the app point, then the title point, then the system point, all
  // at `wallMs` or `wallMs + 1`, keep the order they were pushed in.
  return steps.sort((a, b) => a.atMs - b.atMs)
}

/* ---- flags ---------------------------------------------------------------- */

export interface MockFlags {
  scenario: ScenarioName
  /** Timeline multiplier. 1 is the fixtures' real timings. */
  speed: number
  url: string
  /** The pairing code the device presents. The seed writes `HELI-DEMO`. */
  code: string
  help: boolean
}

export const DEFAULT_URL = 'http://localhost:3001'
export const DEFAULT_CODE = 'HELI-DEMO'

export class MockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MockError'
  }
}

/**
 * `--scenario focused --speed 20`, or `--scenario=focused`. Unknown flags are
 * refused rather than ignored: a typo that silently ran a different scenario
 * would make a demo lie about what it showed.
 */
export function parseMockFlags(argv: readonly string[]): MockFlags {
  const flags: MockFlags = {
    scenario: 'drifting',
    speed: 1,
    url: process.env.HELI_URL ?? DEFAULT_URL,
    code: process.env.HELI_PAIRING_CODE ?? DEFAULT_CODE,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    // `pnpm dev:mock -- --scenario phone` hands the separator through as an
    // argument in pnpm 12; it is punctuation, not a flag.
    if (arg === '--') continue
    const [name, inline] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [arg, undefined]
    const take = (): string => {
      if (inline !== undefined && inline.length > 0) return inline
      index += 1
      const next = argv[index]
      if (next === undefined) throw new MockError(`${arg} needs a value`)
      return next
    }

    switch (name) {
      case 'help':
      case 'h':
        flags.help = true
        break
      case 'scenario': {
        const value = take()
        if (!isScenarioName(value)) {
          throw new MockError(
            `unknown --scenario ${value}; expected one of ${SCENARIO_NAMES.join(', ')}`,
          )
        }
        flags.scenario = value
        break
      }
      case 'speed': {
        const value = Number(take())
        if (!Number.isFinite(value) || value <= 0) {
          throw new MockError("--speed must be a positive number (1 = the fixtures' real timings)")
        }
        flags.speed = value
        break
      }
      case 'url':
        flags.url = take().replace(/\/+$/, '')
        break
      case 'code':
        flags.code = take()
        break
      default:
        throw new MockError(`unknown flag ${arg}; try --help`)
    }
  }

  return flags
}

export const helpText = (): string =>
  [
    'mock-device + mock-desktop — the fake Pi and the fake desktop: no hardware, no permissions.',
    '',
    'Usage: pnpm --filter @heli/server dev:mock [--scenario <name>] [--speed <n>] [--url <url>]',
    '',
    '  --scenario <name>   ' + SCENARIO_NAMES.join(' | ') + '   (default: drifting)',
    ...SCENARIO_NAMES.map((name) => `                      ${name}: ${SCENARIOS[name].summary}`),
    "  --speed <n>         timeline multiplier. 1 = the fixtures' real timings (default: 1)",
    `  --url <url>         server to drive (default: $HELI_URL or ${DEFAULT_URL})`,
    `  --code <code>       pairing code (default: $HELI_PAIRING_CODE or ${DEFAULT_CODE})`,
    '',
    'The server must already be running: `pnpm --filter @heli/server dev`.',
  ].join('\n')

/* ---- http + sockets ------------------------------------------------------- */

export const isAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    if (signal?.aborted === true) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const unreachable = (url: string, error: unknown): MockError =>
  new MockError(
    `cannot reach the Helicopter server at ${url} (${
      error instanceof Error ? error.message : String(error)
    }) — start it first, e.g. PORT=3017 node --import tsx src/index.ts`,
  )

export async function request(
  url: string,
  path: string,
  init: { method: 'GET' | 'POST'; token?: string; body?: unknown },
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${url}${path}`, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (error: unknown) {
    throw unreachable(url, error)
  }

  const text = await response.text()
  if (!response.ok) {
    // The server never sends a stack trace and neither does this. The body is
    // quoted verbatim so a 409 "no active goal" reads as itself.
    throw new MockError(`${init.method} ${path} → ${response.status}: ${text.slice(0, 300)}`)
  }
  return text.length === 0 ? null : (JSON.parse(text) as unknown)
}

/**
 * A socket that opens with the contract's protocol:
 * `Sec-WebSocket-Protocol: heli.v1, <token>`. The token is the value *after* the
 * protocol name and never becomes the negotiated subprotocol, and it stays out
 * of the url — which is what keeps it out of the server's access log.
 */
export function openSocket(
  url: string,
  path: string,
  token: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}${path}`, [HELI_SOCKET_PROTOCOL, token])
    const onAbort = (): void => {
      ws.close(1000, 'interrupted')
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    ws.addEventListener('open', () => {
      signal?.removeEventListener('abort', onAbort)
      // The desktop socket carries JSON only; this is set for the device socket,
      // where §6's tagged binary could arrive. Some implementations refuse the
      // assignment, which is nothing this mock needs.
      try {
        ws.binaryType = 'arraybuffer'
      } catch {
        /* ignore */
      }
      log.info({ path }, 'socket open')
      resolvePromise(ws)
    })
    ws.addEventListener('error', () => {
      signal?.removeEventListener('abort', onAbort)
      reject(
        new MockError(
          `could not open ${path} at ${url} — is the server running, and is the credential valid?`,
        ),
      )
    })
  })
}

/* ---- the desktop replay --------------------------------------------------- */

export interface DesktopMockOptions {
  url: string
  scenario: ScenarioName
  speed: number
  /**
   * The session the device opened. `null` stands the desktop up on its own: it
   * then uses the newest open session for the paired device, or opens one over
   * `POST /v1/sessions`.
   */
  sessionId: string | null
  signal?: AbortSignal
  log?: Logger
}

export interface DesktopMockResult {
  sessionId: string
  deviceId: string
  scenario: ScenarioName
  batches: number
  /** Signals handed over per transport. */
  posted: number
  socketed: number
  signals: number
  /** Error codes the server sent back on the desktop socket, if any. */
  refused: string[]
}

/** The desktop's own flush cadence — `apps/desktop/src/lib/native.ts#FLUSH_MS`. */
const FLUSH_MS = 5_000

/**
 * Signs in, finds the device and the session, opens `/ws/desktop`, and replays
 * the scenario's fixture windows as real signals.
 */
export async function runDesktopMock(options: DesktopMockOptions): Promise<DesktopMockResult> {
  const log = options.log ?? childLogger({ module: 'mock.desktop' })
  const { url, scenario, speed, signal } = options
  const plan = SCENARIOS[scenario]

  const login = (await request(url, '/v1/auth/dev-login', { method: 'POST', body: {} })) as {
    token: string
    user: { email: string }
  }
  const token = login.token

  const devices = (await request(url, '/v1/devices', { method: 'GET', token })) as Device[]
  const device = devices[0]
  if (device === undefined) {
    throw new MockError(
      'no device is paired — run `pnpm --filter @heli/server db:seed` (it writes the HELI-DEMO device)',
    )
  }

  const goals = (await request(url, '/v1/goals', { method: 'GET', token })) as Goal[]
  const goal = goals.find((candidate) => candidate.active)
  if (goal === undefined) {
    throw new MockError(
      'no active goal — run `pnpm --filter @heli/server db:seed`. The desktop is classified against ' +
        "it: the fixtures' distraction labels are mapped onto its blockedSites.",
    )
  }

  let sessionId = options.sessionId
  if (sessionId === null) {
    const sessions = (await request(url, '/v1/sessions', { method: 'GET', token })) as {
      id: string
      deviceId: string
      endedAt: string | null
    }[]
    const open = sessions.find((s) => s.deviceId === device.id && s.endedAt === null)
    if (open === undefined) {
      const created = (await request(url, '/v1/sessions', {
        method: 'POST',
        token,
        body: { deviceId: device.id, goalId: null },
      })) as { session: { id: string } }
      sessionId = created.session.id
      log.info({ sessionId }, 'no open session for the device; opened one')
    } else {
      sessionId = open.id
    }
  }

  log.info(
    {
      user: login.user.email,
      device: device.name,
      deviceId: device.id,
      sessionId,
      goal: { id: goal.id, objective: goal.objective, blockedSites: goal.blockedSites },
      scenario,
      speed,
      windows: plan.windows,
    },
    speed === 1
      ? 'replaying the fixture windows at their real timings (minutes, not seconds)'
      : `replaying the fixture windows at ${speed}x (durations divide by ${speed}; rates do not)`,
  )

  const socket = await openSocket(url, '/ws/desktop', token, log, signal)
  const acks: number[] = []
  const refused: string[] = []

  /**
   * The only frames the server sends down this socket are `ack` and `error`
   * (`ApiToDesktop`) — the outbound channel is SSE, and `ws/desktop.ts` says so.
   * `DesktopToApi` above is the other direction, and using the wrong one of the
   * two is exactly the mistake this validation exists to catch.
   */
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    let parsed: ReturnType<typeof ApiToDesktop.safeParse>
    try {
      parsed = ApiToDesktop.safeParse(JSON.parse(event.data) as unknown)
    } catch {
      log.warn({ data: event.data.slice(0, 200) }, 'the server sent a frame that is not JSON')
      return
    }
    if (!parsed.success) {
      log.warn({ data: event.data.slice(0, 200) }, 'the server sent a frame the mock cannot read')
      return
    }
    const frame = parsed.data
    if (frame.t === 'ack') acks.push(frame.accepted)
    else if (frame.t === 'error') {
      refused.push(frame.code)
      log.warn({ code: frame.code, message: frame.message }, 'the server refused a batch')
    } else {
      // `audio.out` and `nudge` are deliveries, not refusals. The mock has no
      // speaker and no notification surface, so it notes them and moves on.
      log.info({ t: frame.t }, 'the server sent a delivery')
    }
  })

  const send = (message: unknown): void => {
    const validated = DesktopToApi.safeParse(message)
    if (!validated.success) {
      throw new MockError(
        `the mock built a frame DesktopToApi rejects: ${
          validated.error.issues[0]?.message ?? 'invalid'
        }`,
      )
    }
    socket.send(JSON.stringify(validated.data))
  }

  send({ t: 'hello', appVersion: '0.1.0-mock', deviceId: device.id, sessionId })

  /**
   * `hello` is acked (with `accepted: 0` — the union has no hello-specific
   * reply), and that ack is worth waiting for: if it never comes the socket is
   * not really live and every batch below would go into a void. It is also why
   * the ack accounting further down starts *after* this one.
   */
  const helloDeadline = Date.now() + 5_000
  while (acks.length + refused.length === 0 && Date.now() < helloDeadline) {
    if (signal?.aborted === true) break
    await sleep(25, signal).catch(() => undefined)
  }
  if (acks.length + refused.length === 0) {
    log.warn('the server never acked hello; sending signals anyway')
  }
  const acksBeforeBatches = acks.length + refused.length

  const files = await Promise.all(plan.windows.map((id) => readFixtureWindow(id)))
  const segments = files.flatMap((file) => {
    log.info({ fixture: file.id, note: file.note }, 'fixture window')
    return segmentsOfFixture(file, log)
  })
  const steps = stepsOf(segments, Date.now(), speed)
  log.info(
    { steps: steps.length, signals: steps.reduce((sum, step) => sum + step.signals.length, 0) },
    'timeline built from the fixtures',
  )

  const pending: SignalContract[] = []
  let batches = 0
  let posted = 0
  let socketed = 0
  let signals = 0
  /** Batches handed to the socket and not yet answered — see the wait below. */
  let awaitingAcks = 0

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    const batch = SignalBatch.parse({
      deviceId: device.id,
      sessionId,
      signals: pending.splice(0, pending.length),
    })
    /**
     * The first batch goes over HTTP — the desktop's offline flush, which is
     * exactly what `POST /v1/signals` exists for — and every batch after it over
     * the socket, which is the live path. Both end in `ingestSignals`, so this
     * is two doors into one room and not two implementations.
     */
    if (batches === 0) {
      const result = (await request(url, '/v1/signals', {
        method: 'POST',
        token,
        body: batch,
      })) as { accepted: number }
      posted += batch.signals.length
      log.info(
        { transport: 'POST /v1/signals', accepted: result.accepted, signals: batch.signals.length },
        'flushed the first batch',
      )
    } else {
      send({ t: 'signals', ...batch })
      socketed += batch.signals.length
      awaitingAcks += 1
    }
    batches += 1
    signals += batch.signals.length
  }

  let clockMs = 0
  let lastFlushAt = 0
  for (const step of steps) {
    const waitMs = step.atMs - clockMs
    if (waitMs > 0) await sleep(waitMs, signal)
    clockMs = step.atMs

    for (const raw of step.signals) {
      const parsed = Signal.safeParse(raw)
      if (!parsed.success) {
        throw new MockError(
          `the mock built a signal the contract rejects: ${
            parsed.error.issues[0]?.message ?? 'invalid'
          }`,
        )
      }
      pending.push(parsed.data)
    }

    /**
     * Flushed on the desktop's own 5 s cadence, and early when a batch has grown
     * — the same frame either way, so the server's `ack` counts are comparable.
     */
    if (step.atMs - lastFlushAt >= FLUSH_MS || pending.length >= 50) {
      await flush()
      lastFlushAt = step.atMs
    }
  }
  await flush()

  /**
   * Wait for the acks before saying what the server accepted and before closing
   * the socket. Without this the summary reports a count that is short by
   * whatever was still in flight, which is precisely the number someone quoting
   * this output would believe.
   */
  const ackDeadline = Date.now() + 10_000
  while (
    awaitingAcks > acks.length + refused.length - acksBeforeBatches &&
    Date.now() < ackDeadline
  ) {
    if (signal?.aborted === true) break
    await sleep(25, signal).catch(() => undefined)
  }

  log.info(
    {
      sessionId,
      scenario,
      batches,
      signals,
      byTransport: { 'POST /v1/signals': posted, '/ws/desktop': socketed },
      acceptedByServer: acks.reduce((sum, value) => sum + value, 0) + posted,
      ackSizes: acks,
      refusedBatches: refused,
    },
    'replayed the work pattern as real signals',
  )

  if (socket.readyState === 1) socket.close(1000, 'replay finished')

  return {
    sessionId,
    deviceId: device.id,
    scenario,
    batches,
    posted,
    socketed,
    signals,
    refused,
  }
}

/* ---- standalone ----------------------------------------------------------- */

/** `node --import tsx src/dev/mock-desktop.ts` runs the desktop alone. */
const isEntryPoint = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) {
  const controller = new AbortController()
  process.once('SIGINT', () => {
    process.stdout.write('mock-desktop: interrupted, closing the socket\n')
    controller.abort()
  })

  const main = async (): Promise<void> => {
    const flags = parseMockFlags(process.argv.slice(2))
    if (flags.help) {
      process.stdout.write(`${helpText()}\n`)
      return
    }
    await runDesktopMock({
      url: flags.url,
      scenario: flags.scenario,
      speed: flags.speed,
      sessionId: null,
      signal: controller.signal,
    })
  }

  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      if (isAbort(error)) process.exit(0)
      process.stderr.write(
        `mock-desktop: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    })
}
