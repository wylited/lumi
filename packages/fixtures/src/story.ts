/**
 * The raw story, before it becomes contract shapes. One `WindowSpec` is one minute of desk and
 * machine, which the builder turns into a `SignalWindow`, an `Assessment` and — when the tier is
 * above 0 — the `Intervention` the policy fired.
 */

export interface WindowSpec {
  /** Minutes since the session started; the window covers `[minute - 1, minute)`. */
  minute: number
  onTask: boolean
  activity: 'working' | 'reading' | 'writing' | 'browsing' | 'phone' | 'away' | 'break'
  kind: string | null
  app: string
  site: string | null
  /** Seconds of the current off-goal run at the end of this window. */
  driftSeconds: number
  /** Seconds off-task inside this window only. */
  offTaskSeconds: number
  idleSeconds: number
  tier: number
  confidence: number
  latencyMs: number
  reason: string
}

export interface Distraction {
  kind: string
  app: string
  site: string | null
  activity: WindowSpec['activity']
}

export const DISTRACTIONS: Distraction[] = [
  { kind: 'video', app: 'Safari', site: 'youtube.com', activity: 'browsing' },
  { kind: 'social', app: 'Safari', site: 'x.com', activity: 'browsing' },
  { kind: 'social', app: 'Safari', site: 'reddit.com', activity: 'browsing' },
  { kind: 'news', app: 'Safari', site: 'news.ycombinator.com', activity: 'browsing' },
  { kind: 'chat', app: 'Discord', site: null, activity: 'browsing' },
  { kind: 'phone', app: 'Code', site: null, activity: 'phone' },
]

const ON_TASK: Array<Pick<WindowSpec, 'app' | 'site' | 'activity'>> = [
  { app: 'Code', site: null, activity: 'working' },
  { app: 'Code', site: null, activity: 'working' },
  { app: 'Code', site: null, activity: 'working' },
  { app: 'Notes', site: null, activity: 'writing' },
  { app: 'Safari', site: 'ocw.mit.edu', activity: 'reading' },
  { app: 'Safari', site: 'khanacademy.org', activity: 'reading' },
  { app: 'Preview', site: null, activity: 'reading' },
]

/** mulberry32 — small, fast, and the same numbers on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T
}

function onTaskWindow(minute: number, rand: () => number, place = pick(rand, ON_TASK)): WindowSpec {
  // A short glance away that never becomes a drift is still on task — and still tier 0.
  const glance = rand() < 0.14 ? Math.round(6 + rand() * 18) : 0
  return {
    minute,
    onTask: true,
    ...place,
    kind: null,
    driftSeconds: 0,
    offTaskSeconds: glance,
    idleSeconds: place.activity === 'reading' ? Math.round(rand() * 20) : Math.round(rand() * 4),
    tier: 0,
    confidence: round(0.86 + rand() * 0.1),
    latencyMs: Math.round(1080 + rand() * 360),
    reason: 'on_goal',
  }
}

function breakWindow(minute: number, rand: () => number): WindowSpec {
  return {
    minute,
    onTask: true,
    app: 'loginwindow',
    site: null,
    activity: 'break',
    kind: null,
    driftSeconds: 0,
    offTaskSeconds: 0,
    idleSeconds: 60,
    tier: 0,
    confidence: round(0.9 + rand() * 0.06),
    latencyMs: Math.round(980 + rand() * 200),
    reason: 'break',
  }
}

/**
 * An off-goal run of `length` windows, escalated the way the policy does it: the first window is
 * ambient, a sustained second one nudges, and a third — the nudge unresolved — speaks. After a
 * spoken line the gaps hold the tier at ambient.
 */
function driftRun(
  start: number,
  length: number,
  distraction: Distraction,
  rand: () => number,
  maxTier: number,
): WindowSpec[] {
  const out: WindowSpec[] = []
  let drift = Math.round(34 + rand() * 12)
  for (let i = 0; i < length; i += 1) {
    const tier = Math.min(maxTier, i === 0 ? 1 : i === 1 ? 2 : i === 2 ? 3 : 1)
    out.push({
      minute: start + i,
      onTask: false,
      app: distraction.app,
      site: distraction.site,
      activity: distraction.activity,
      kind: distraction.kind,
      driftSeconds: drift,
      offTaskSeconds: i === 0 ? drift : 60,
      idleSeconds: distraction.kind === 'phone' ? 48 : Math.round(rand() * 6),
      tier,
      confidence: round(0.74 + rand() * 0.18),
      latencyMs: Math.round(1320 + rand() * 420),
      reason: i === 0 ? 'ambient_drift' : i === 1 ? 'sustained_drift' : 'nudge_unresolved',
    })
    drift += 60
  }
  return out
}

/**
 * The seeded session from `apps/server/prisma/seed.ts`, told minute by minute: settle in, drift to
 * YouTube, ignore the nudge, come back after the spoken line, a pomodoro break, one short drift to
 * Hacker News that the tray alone fixes, and finish.
 */
export function seedStory(): WindowSpec[] {
  const rand = rng(7)
  const out: WindowSpec[] = []
  for (let m = 1; m <= 12; m += 1) out.push(onTaskWindow(m, rand))
  out.push(...driftRun(13, 3, DISTRACTIONS[0] as Distraction, rand, 3))
  for (let m = 16; m <= 25; m += 1) out.push(onTaskWindow(m, rand))
  for (let m = 26; m <= 30; m += 1) out.push(breakWindow(m, rand))
  for (let m = 31; m <= 34; m += 1) out.push(onTaskWindow(m, rand))
  out.push(...driftRun(35, 1, DISTRACTIONS[3] as Distraction, rand, 3))
  for (let m = 36; m <= 40; m += 1) out.push(onTaskWindow(m, rand))
  return out
}

/** A procedurally told session: mostly focus, a few drifts of varying stubbornness. */
export function proceduralStory(seed: number, minutes: number): WindowSpec[] {
  const rand = rng(seed)
  const out: WindowSpec[] = []
  const focusBias = 0.9 + rand() * 0.07
  let m = 1
  while (m <= minutes) {
    const pomodoroBreak = m > 1 && m % 30 >= 26 && minutes - m > 8
    if (pomodoroBreak) {
      out.push(breakWindow(m, rand))
      m += 1
      continue
    }
    if (m > 3 && rand() > focusBias) {
      const roll = rand()
      const length = roll < 0.55 ? 1 : roll < 0.85 ? 2 : roll < 0.96 ? 3 : 4
      const run = driftRun(m, Math.min(length, minutes - m + 1), pick(rand, DISTRACTIONS), rand, 3)
      out.push(...run)
      m += run.length
      continue
    }
    out.push(onTaskWindow(m, rand))
    m += 1
  }
  return out
}

export function round(n: number, places = 2): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}
