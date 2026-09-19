import {
  DEFAULT_POLICY,
  type Assessment,
  type Goal,
  type Intervention,
  type Observation,
  type Outcome,
  type Session,
  type SessionDetail,
  type SessionSummary,
  type SignalWindow,
} from '@heli/contracts'
import { round, type WindowSpec } from './story.js'

export const USER = { id: 'user_seed', email: 'me@heli.local', name: 'Ari' } as const
export const DEVICE_ID = 'dev_seed'
export const GOAL_ID = 'goal_seed'
export const SEED_SESSION_ID = 'sess_seed'

export function seedGoal(createdAt: Date): Goal {
  return {
    id: GOAL_ID,
    kind: 'study',
    objective: 'Finish the linear algebra problem set',
    successCriteria: 'All 12 problems attempted, with working written up',
    timeBudgetMinutes: 50,
    breakPolicy: 'pomodoro_25_5',
    allowedApps: ['Code', 'Safari', 'Notes', 'Preview', 'Calculator'],
    blockedApps: ['Discord', 'Slack', 'Steam'],
    allowedSites: ['khanacademy.org', 'ocw.mit.edu', 'web.mit.edu'],
    blockedSites: ['youtube.com', 'twitter.com', 'x.com', 'reddit.com'],
    permissions: ['nudge', 'speak'],
    automations: [],
    policy: { ...DEFAULT_POLICY, maxTier: 3 },
    active: true,
    createdAt: createdAt.toISOString(),
  }
}

const CHANNEL_BY_TIER = [
  'log',
  'ambient',
  'notification',
  'speech',
  'automation',
  'summary',
] as const

/**
 * The policy's words, not a model's: every message is a template filled with facts the window
 * already holds. This is what "the model never writes free text to a speaker" looks like in data.
 */
function messageFor(spec: WindowSpec, goal: Goal): string | null {
  const where = spec.site ?? spec.app
  const minutes = Math.max(1, Math.round(spec.driftSeconds / 60))
  switch (spec.tier) {
    case 2:
      return `Back to the ${goalNoun(goal)} when you get a sec.`
    case 3:
      return spec.kind === 'phone'
        ? `Phone's been out for ${minutes} min — the ${goalNoun(goal)} is waiting.`
        : `You've been on ${where} for ${minutes} min — the ${goalNoun(goal)} is waiting.`
    default:
      return null
  }
}

function goalNoun(goal: Goal): string {
  return goal.objective.replace(/^(finish|write|do|complete)\s+(the\s+)?/i, '').toLowerCase()
}

function signalWindow(spec: WindowSpec, start: Date): SignalWindow {
  const to = new Date(start.getTime() + spec.minute * 60_000)
  const from = new Date(to.getTime() - 60_000)
  const focusedSeconds =
    spec.activity === 'break' ? 0 : Math.max(0, 60 - spec.offTaskSeconds - spec.idleSeconds)
  const topApps = spec.onTask
    ? spec.activity === 'break'
      ? []
      : [{ app: spec.app, seconds: 60 - spec.offTaskSeconds, onTask: true }]
    : [
        { app: spec.app, seconds: spec.offTaskSeconds, onTask: false },
        ...(spec.offTaskSeconds < 60
          ? [{ app: 'Code', seconds: 60 - spec.offTaskSeconds, onTask: true }]
          : []),
      ]
  const topSites = spec.site
    ? [{ title: spec.site, seconds: spec.onTask ? 60 : spec.offTaskSeconds, onTask: spec.onTask }]
    : []
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    windowMs: 60_000,
    focusedSeconds,
    offTaskSeconds: spec.offTaskSeconds,
    idleSeconds: spec.idleSeconds,
    contextSwitches: spec.onTask
      ? spec.offTaskSeconds > 0
        ? 2
        : spec.activity === 'break'
          ? 0
          : 1
      : 4,
    longestFocusRunSeconds: focusedSeconds,
    inputRate:
      spec.activity === 'break'
        ? 0
        : spec.onTask
          ? round(22 + (spec.confidence - 0.8) * 120, 1)
          : 6.4,
    onTaskRatio: spec.activity === 'break' ? 1 : round((60 - spec.offTaskSeconds) / 60),
    topApps,
    topSites,
    focusMode: false,
    lastFrameRef: `frame_${spec.minute}`,
    lastScreenRef: spec.activity === 'break' ? null : `screen_${spec.minute}`,
  }
}

function assessment(spec: WindowSpec): Assessment {
  const evidence = spec.onTask
    ? spec.activity === 'break'
      ? ['desk empty', 'no input for 60s', 'inside a pomodoro break']
      : [
          `frontmost app: ${spec.app}`,
          spec.site ? `tab title: ${spec.site}` : 'input cadence steady',
        ]
    : [
        spec.kind === 'phone' ? 'phone in hand at the desk' : `frontmost app: ${spec.app}`,
        spec.site ? `tab title: ${spec.site}` : 'no window title',
        `off-task for ${spec.driftSeconds}s`,
      ]
  return {
    onTask: spec.onTask,
    activity: spec.activity,
    kind: spec.kind,
    driftSeconds: spec.driftSeconds,
    evidence,
    confidence: spec.confidence,
    because: spec.onTask
      ? spec.activity === 'break'
        ? 'Away during a scheduled break.'
        : 'Frontmost app matches the goal and input is steady.'
      : spec.kind === 'phone'
        ? `Phone in hand for ${spec.driftSeconds}s, the editor untouched.`
        : `${spec.site ?? spec.app} is off the goal for ${spec.driftSeconds}s.`,
  }
}

export interface BuiltSession {
  session: Session
  detail: SessionDetail
}

export function buildSession(
  id: string,
  start: Date,
  specs: WindowSpec[],
  goal: Goal,
  opts: { live?: boolean } = {},
): BuiltSession {
  const observations: Observation[] = specs.map((spec, i) => {
    const next = specs[i + 1]
    const outcome: Outcome | null =
      spec.tier === 0
        ? null
        : next === undefined
          ? opts.live
            ? null
            : 'unknown'
          : next.onTask
            ? 'resolved'
            : 'ignored'
    const action: Intervention | null =
      spec.tier === 0
        ? null
        : {
            tier: spec.tier,
            channel: CHANNEL_BY_TIER[spec.tier] ?? 'log',
            message: messageFor(spec, goal),
            action: null,
            reversible: true,
            reason: spec.reason,
          }
    const window = signalWindow(spec, start)
    return {
      id: `${id}_obs_${String(spec.minute).padStart(2, '0')}`,
      sessionId: id,
      ts: window.to,
      signals: window,
      assessment: assessment(spec),
      tier: spec.tier,
      action,
      outcome,
      confidence: spec.confidence,
      reason: spec.reason,
      latencyMs: spec.latencyMs,
    }
  })

  const interventions = observations.flatMap((o) => (o.action ? [o.action] : []))
  const tierHistogram: Record<string, number> = {}
  for (const o of observations)
    tierHistogram[String(o.tier)] = (tierHistogram[String(o.tier)] ?? 0) + 1

  const minutes = specs.length
  const endedAt = opts.live ? null : new Date(start.getTime() + minutes * 60_000)
  const summary = opts.live ? null : summarise(observations, goal)

  const session: Session = {
    id,
    deviceId: DEVICE_ID,
    goalId: goal.id,
    startedAt: start.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    durationMs: endedAt ? endedAt.getTime() - start.getTime() : null,
    signalCount: minutes * 58,
    observationCount: observations.length,
    interventionCount: interventions.length,
    tierHistogram,
    summary,
  }
  return { session, detail: { ...session, goal, observations, interventions } }
}

export function summarise(observations: Observation[], goal: Goal): SessionSummary {
  let focused = 0
  let off = 0
  let run = 0
  let longest = 0
  const distraction = new Map<string, number>()
  const worked = new Map<string, { tier: number; outcome: string; count: number }>()

  for (const o of observations) {
    focused += o.signals.focusedSeconds
    off += o.signals.offTaskSeconds
    if (o.assessment?.onTask && o.assessment.activity !== 'break') {
      run += o.signals.focusedSeconds
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
    if (o.assessment && !o.assessment.onTask) {
      const key =
        o.signals.topSites[0]?.title ??
        (o.assessment.kind === 'phone' ? 'Phone' : (o.signals.topApps[0]?.app ?? 'Unknown'))
      distraction.set(key, (distraction.get(key) ?? 0) + o.signals.offTaskSeconds)
    }
    if (o.tier > 0 && o.outcome) {
      const key = `${o.tier}:${o.outcome}`
      const row = worked.get(key) ?? { tier: o.tier, outcome: o.outcome, count: 0 }
      row.count += 1
      worked.set(key, row)
    }
  }

  const top = [...distraction.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const focusedMinutes = round(focused / 60, 1)
  const offTaskMinutes = round(off / 60, 1)
  const loud = observations.filter((o) => o.tier >= 2)
  const landed = loud.filter((o) => o.outcome === 'resolved')

  const message =
    loud.length === 0
      ? `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(goal)}. Nothing needed saying.`
      : `${Math.round(focusedMinutes)} focused minutes on the ${goalNoun(goal)}. ${landed.length} of ${loud.length} interruptions brought you back.`

  return {
    focusedMinutes,
    offTaskMinutes,
    longestFocusRunSeconds: longest,
    topDistraction: top,
    worked: [...worked.values()].sort(
      (a, b) => a.tier - b.tier || a.outcome.localeCompare(b.outcome),
    ),
    message,
  }
}
