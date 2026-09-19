/**
 * Fixture generator for the observer loop.
 *
 * `pnpm --filter @heli/server gen:fixtures`
 *
 * Writes:
 *   fixtures/windows/<id>.json   a valid SignalWindow in a small wrapper
 *   fixtures/frames/<id>.jpg     a real baseline JPEG (via zlib PNG + macOS sips)
 *   fixtures/expected.json       the expected assessment + policy tier per id
 *
 * The single source of truth is SPECS below. Adding a fixture is a data change.
 * If no JPEG encoder is available the windows and expected outcomes are still
 * written and the frames directory is left empty — never fake bytes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import type { GoalKind, SignalWindow } from '@heli/contracts'
import { SignalWindow as SignalWindowSchema } from '@heli/contracts'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, '../../fixtures')
const windowsDir = join(fixturesDir, 'windows')
const framesDir = join(fixturesDir, 'frames')
const expectedPath = join(fixturesDir, 'expected.json')

// A fixed clock keeps regenerated windows byte-identical.
const BASE_TS = Date.parse('2026-01-15T09:00:00.000Z')

interface AppEntry {
  app: string
  seconds: number
  onTask: boolean
}
interface SiteEntry {
  title: string
  seconds: number
  onTask: boolean
}

interface WindowInput {
  windowMs: number
  focusedSeconds: number
  offTaskSeconds: number
  idleSeconds: number
  contextSwitches: number
  longestFocusRunSeconds: number
  inputRate: number
  topApps: AppEntry[]
  topSites: SiteEntry[]
  focusMode: boolean
  lastFrameRef: string | null
  lastScreenRef: string | null
}

interface FrameStyle {
  tint: [number, number, number]
  accent: [number, number, number]
  pattern: 'gradient' | 'noise' | 'dark' | 'blur'
}

interface FixtureSpec {
  id: string
  goalKind: GoalKind
  note: string
  frame: FrameStyle
  window: WindowInput
  expected: {
    onTrack: boolean
    kind: string | null
    expectedTier: number
    note: string
  }
}

/**
 * The twelve windows. `onTaskRatio` is derived from `focusedSeconds` and the
 * window length, never authored. Every window satisfies
 * `focusedSeconds + offTaskSeconds === windowMs / 1000`.
 *
 * `expectedTier` is what `apps/server/src/observe/policy.ts` should decide for
 * the window under DEFAULT_POLICY and a goal with permissions `['nudge','speak']`
 * and `maxTier: 3` — so tiers 4 and 5 are unreachable here by construction.
 */
const SPECS: FixtureSpec[] = [
  {
    id: 'focused-desk-10m',
    goalKind: 'study',
    note: 'Ten minutes at the desk, editor frontmost, steady input.',
    frame: { tint: [22, 40, 58], accent: [120, 200, 180], pattern: 'gradient' },
    window: {
      windowMs: 600_000,
      focusedSeconds: 585,
      offTaskSeconds: 15,
      idleSeconds: 45,
      contextSwitches: 4,
      longestFocusRunSeconds: 300,
      inputRate: 110,
      topApps: [{ app: 'Code', seconds: 540, onTask: true }],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'focused-desk-10m',
      lastScreenRef: null,
    },
    expected: {
      onTrack: true,
      kind: null,
      expectedTier: 0,
      note: 'On task, high confidence. No sustained drift, so nothing to interrupt — tier 0 silence.',
    },
  },
  {
    id: 'focus-run-2m',
    goalKind: 'study',
    note: 'A two-minute focus run, still on task.',
    frame: { tint: [20, 55, 45], accent: [90, 220, 160], pattern: 'gradient' },
    window: {
      windowMs: 120_000,
      focusedSeconds: 120,
      offTaskSeconds: 0,
      idleSeconds: 10,
      contextSwitches: 0,
      longestFocusRunSeconds: 120,
      inputRate: 90,
      topApps: [{ app: 'Code', seconds: 120, onTask: true }],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'focus-run-2m',
      lastScreenRef: null,
    },
    expected: {
      onTrack: true,
      kind: null,
      expectedTier: 0,
      note: 'On task; a short run is not a reason to intervene — tier 0.',
    },
  },
  {
    id: 'off-task-social-40s',
    goalKind: 'study',
    note: 'First off-goal window: 40 s on a social feed.',
    frame: { tint: [30, 30, 90], accent: [120, 120, 240], pattern: 'noise' },
    window: {
      windowMs: 60_000,
      focusedSeconds: 20,
      offTaskSeconds: 40,
      idleSeconds: 2,
      contextSwitches: 6,
      longestFocusRunSeconds: 20,
      inputRate: 140,
      topApps: [{ app: 'Safari', seconds: 40, onTask: false }],
      topSites: [{ title: 'Social feed', seconds: 35, onTask: false }],
      focusMode: false,
      lastFrameRef: 'off-task-social-40s',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: 'social',
      expectedTier: 1,
      note: 'Drift 40 s ≥ driftSeconds 30, but consecutiveOffGoal 1 < 2, so not sustained. Ambient only — tier 1.',
    },
  },
  {
    id: 'off-task-video-90s',
    goalKind: 'study',
    note: 'Second consecutive off-goal window: 90 s of video.',
    frame: { tint: [70, 20, 30], accent: [240, 120, 90], pattern: 'noise' },
    window: {
      windowMs: 120_000,
      focusedSeconds: 30,
      offTaskSeconds: 90,
      idleSeconds: 20,
      contextSwitches: 4,
      longestFocusRunSeconds: 30,
      inputRate: 130,
      topApps: [{ app: 'Safari', seconds: 85, onTask: false }],
      topSites: [{ title: 'Video site', seconds: 82, onTask: false }],
      focusMode: false,
      lastFrameRef: 'off-task-video-90s',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: 'video',
      expectedTier: 2,
      note: 'Second consecutive off-goal window, drift 90 s ≥ 30 s and confidence ≥ minConfidence 0.7. Nudge permitted, nudge gap elapsed — tier 2.',
    },
  },
  {
    id: 'phone-in-hand',
    goalKind: 'study',
    note: 'Third consecutive off-goal window: phone in hand while the desk frame is present; the prior nudge went unresolved.',
    frame: { tint: [40, 40, 40], accent: [200, 200, 220], pattern: 'noise' },
    window: {
      windowMs: 60_000,
      focusedSeconds: 0,
      offTaskSeconds: 60,
      idleSeconds: 55,
      contextSwitches: 2,
      longestFocusRunSeconds: 0,
      inputRate: 15,
      topApps: [{ app: 'Instagram', seconds: 50, onTask: false }],
      topSites: [{ title: 'Feed', seconds: 45, onTask: false }],
      focusMode: false,
      lastFrameRef: 'phone-in-hand',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: 'phone',
      expectedTier: 3,
      note: 'The prior nudge was unresolved and the drift continues. Speak permitted, speech gap elapsed, maxTier 3 — tier 3.',
    },
  },
  {
    id: 'away-idle',
    goalKind: 'life',
    note: 'Away from the desk, screen idle.',
    frame: { tint: [35, 32, 28], accent: [90, 88, 84], pattern: 'dark' },
    window: {
      windowMs: 300_000,
      focusedSeconds: 30,
      offTaskSeconds: 270,
      idleSeconds: 270,
      contextSwitches: 1,
      longestFocusRunSeconds: 30,
      inputRate: 0,
      topApps: [],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'away-idle',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: 'away',
      expectedTier: 0,
      note: 'Nobody at the desk to act on; like a meeting, an empty desk suppresses everything — tier 0.',
    },
  },
  {
    id: 'reading-low-input',
    goalKind: 'study',
    note: 'Head down reading; low input rate but on task.',
    frame: { tint: [50, 40, 25], accent: [220, 190, 130], pattern: 'gradient' },
    window: {
      windowMs: 300_000,
      focusedSeconds: 280,
      offTaskSeconds: 20,
      idleSeconds: 240,
      contextSwitches: 2,
      longestFocusRunSeconds: 180,
      inputRate: 8,
      topApps: [{ app: 'Books', seconds: 270, onTask: true }],
      topSites: [],
      focusMode: true,
      lastFrameRef: 'reading-low-input',
      lastScreenRef: null,
    },
    expected: {
      onTrack: true,
      kind: null,
      expectedTier: 0,
      note: 'Low inputRate with focusMode is reading, not drift. On task — tier 0.',
    },
  },
  {
    id: 'second-person',
    goalKind: 'study',
    note: 'A second person at the desk; it is ambiguous who, if anyone, is working.',
    frame: { tint: [45, 45, 55], accent: [170, 170, 190], pattern: 'blur' },
    window: {
      windowMs: 60_000,
      focusedSeconds: 30,
      offTaskSeconds: 30,
      idleSeconds: 15,
      contextSwitches: 3,
      longestFocusRunSeconds: 30,
      inputRate: 60,
      topApps: [{ app: 'Code', seconds: 30, onTask: true }],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'second-person',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: 'other_person',
      expectedTier: 0,
      note: 'The scene cannot be attributed with confidence ≥ minConfidence 0.7; assumeSilentOnDoubt keeps the policy silent — tier 0.',
    },
  },
  {
    id: 'dark-room',
    goalKind: 'study',
    note: 'Dark room; the frame carries almost no information.',
    frame: { tint: [6, 6, 10], accent: [18, 18, 26], pattern: 'dark' },
    window: {
      windowMs: 60_000,
      focusedSeconds: 0,
      offTaskSeconds: 60,
      idleSeconds: 60,
      contextSwitches: 0,
      longestFocusRunSeconds: 0,
      inputRate: 0,
      topApps: [],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'dark-room',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: null,
      expectedTier: 0,
      note: 'Low-information frame ⇒ confidence below the 0.7 floor, so rule 1 blocks every tier — tier 0.',
    },
  },
  {
    id: 'long-focus-12m',
    goalKind: 'work',
    note: 'A twelve-minute focus run, longest continuous run 715 s.',
    frame: { tint: [18, 48, 42], accent: [110, 220, 170], pattern: 'gradient' },
    window: {
      windowMs: 720_000,
      focusedSeconds: 715,
      offTaskSeconds: 5,
      idleSeconds: 120,
      contextSwitches: 2,
      longestFocusRunSeconds: 715,
      inputRate: 95,
      topApps: [{ app: 'Code', seconds: 700, onTask: true }],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'long-focus-12m',
      lastScreenRef: null,
    },
    expected: {
      onTrack: true,
      kind: null,
      expectedTier: 0,
      note: 'On task and sustained. Silence is the correct, recorded result — tier 0.',
    },
  },
  {
    id: 'recovery-after-nudge',
    goalKind: 'study',
    note: 'The window right after a nudge; back on task.',
    frame: { tint: [24, 52, 44], accent: [130, 230, 180], pattern: 'gradient' },
    window: {
      windowMs: 120_000,
      focusedSeconds: 110,
      offTaskSeconds: 10,
      idleSeconds: 20,
      contextSwitches: 3,
      longestFocusRunSeconds: 110,
      inputRate: 105,
      topApps: [{ app: 'Code', seconds: 105, onTask: true }],
      topSites: [],
      focusMode: true,
      lastFrameRef: 'recovery-after-nudge',
      lastScreenRef: null,
    },
    expected: {
      onTrack: true,
      kind: null,
      expectedTier: 0,
      note: 'The drift resolved within resolveWindowMs, so the nudge outcome is `resolved` and the counters reset — tier 0.',
    },
  },
  {
    id: 'blurry-low-info',
    goalKind: 'study',
    note: 'A blurry, low-information frame; should not be acted on.',
    frame: { tint: [60, 60, 62], accent: [95, 95, 100], pattern: 'blur' },
    window: {
      windowMs: 60_000,
      focusedSeconds: 0,
      offTaskSeconds: 60,
      idleSeconds: 50,
      contextSwitches: 1,
      longestFocusRunSeconds: 0,
      inputRate: 5,
      topApps: [],
      topSites: [],
      focusMode: false,
      lastFrameRef: 'blurry-low-info',
      lastScreenRef: null,
    },
    expected: {
      onTrack: false,
      kind: null,
      expectedTier: 0,
      note: 'Blur ⇒ confidence below minConfidence 0.7, and `because` would not be evidence. No intervention — tier 0.',
    },
  },
]

function buildWindow(spec: FixtureSpec): SignalWindow {
  const windowSeconds = spec.window.windowMs / 1000
  if (spec.window.focusedSeconds + spec.window.offTaskSeconds !== windowSeconds) {
    throw new Error(
      `${spec.id}: focusedSeconds + offTaskSeconds (${spec.window.focusedSeconds + spec.window.offTaskSeconds}) must equal window length (${windowSeconds})`,
    )
  }
  const window: SignalWindow = {
    from: new Date(BASE_TS).toISOString(),
    to: new Date(BASE_TS + spec.window.windowMs).toISOString(),
    ...spec.window,
    onTaskRatio: windowSeconds === 0 ? 0 : spec.window.focusedSeconds / windowSeconds,
  }
  // Parse, not just typecheck: the fixture is a contract instance or it is not shipped.
  return SignalWindowSchema.parse(window)
}

// ---------------------------------------------------------------------------
// PNG encoder (RGB, no dependencies). sips turns it into a real baseline JPEG.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function encodePng(width: number, height: number, spec: FixtureSpec): Buffer {
  const rand = mulberry32(
    [...spec.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7),
  )
  const [tr, tg, tb] = spec.frame.tint
  const [ar, ag, ab] = spec.frame.accent
  const raw = Buffer.alloc(height * (1 + width * 3))
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1)
      let r: number
      let g: number
      let b: number
      if (spec.frame.pattern === 'dark') {
        const vignette = 1 - Math.min(1, (x - width / 2) ** 2 + (y - height / 2) ** 2) / (width * width)
        r = tr + ar * 0.2 * vignette
        g = tg + ag * 0.2 * vignette
        b = tb + ab * 0.2 * vignette
      } else if (spec.frame.pattern === 'noise') {
        const n = rand()
        r = tr + (ar - tr) * n
        g = tg + (ag - tg) * n
        b = tb + (ab - tb) * n
      } else if (spec.frame.pattern === 'blur') {
        // Low contrast: only a narrow band of values, so detail is genuinely lost.
        const n = 0.5 + (rand() - 0.5) * 0.06
        r = tr + (ar - tr) * n
        g = tg + (ag - tg) * n
        b = tb + (ab - tb) * n
      } else {
        r = tr + (ar - tr) * t
        g = tg + (ag - tg) * t
        b = tb + (ab - tb) * t
      }
      raw[o++] = Math.max(0, Math.min(255, Math.round(r)))
      raw[o++] = Math.max(0, Math.min(255, Math.round(g)))
      raw[o++] = Math.max(0, Math.min(255, Math.round(b)))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
}

const WIDTH = 320
const HEIGHT = 240

function generateFrame(spec: FixtureSpec): { ok: true } | { ok: false; reason: string } {
  const pngPath = join(tmpdir(), `${spec.id}.png`)
  const jpgPath = join(framesDir, `${spec.id}.jpg`)
  try {
    writeFileSync(pngPath, encodePng(WIDTH, HEIGHT, spec))
    execFileSync('sips', ['-s', 'format', 'jpeg', pngPath, '--out', jpgPath], {
      stdio: 'ignore',
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (existsSync(pngPath)) rmSync(pngPath)
  }
  if (!existsSync(jpgPath)) return { ok: false, reason: 'sips produced no output' }
  const bytes = readFileSync(jpgPath)
  if (!isJpeg(bytes)) {
    rmSync(jpgPath)
    return { ok: false, reason: 'output is not a JPEG (bad magic bytes)' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Write everything.
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(windowsDir, { recursive: true })
  mkdirSync(framesDir, { recursive: true })

  let framesOk = 0
  const failures: string[] = []
  const expected: Record<string, FixtureSpec['expected']> = {}

  for (const spec of SPECS) {
    const window = buildWindow(spec)
    const wrapper = { id: spec.id, note: spec.note, window, goalKind: spec.goalKind }
    writeFileSync(join(windowsDir, `${spec.id}.json`), `${JSON.stringify(wrapper, null, 2)}\n`)

    expected[spec.id] = spec.expected

    const frame = generateFrame(spec)
    if (frame.ok) framesOk++
    else failures.push(`${spec.id}: ${frame.reason}`)
  }

  writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`)

  process.stdout.write(
    `gen-fixtures: wrote ${SPECS.length} windows and expected.json; ` +
      `${framesOk}/${SPECS.length} real JPEG frames\n`,
  )
  if (failures.length > 0) {
    process.stdout.write(`gen-fixtures: no frames for — ${failures.join('; ')}\n`)
  }
}

main()
