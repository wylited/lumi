import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const USER_ID = 'user_seed'
const DEVICE_ID = 'dev_seed'
const GOAL_ID = 'goal_seed'
const SESSION_ID = 'sess_seed'

const SESSION_START = new Date(Date.now() - 40 * 60_000)
const SESSION_END = new Date(SESSION_START.getTime() + 40 * 60_000)

const POLICY: Prisma.InputJsonValue = {
  windowMs: 60_000,
  assessEveryMs: 10_000,
  minConfidence: 0.7,
  driftSeconds: 30,
  consecutiveOffGoal: 2,
  nudgeGapMs: 180_000,
  minGapMs: 90_000,
  maxTier: 2,
  resolveWindowMs: 120_000,
  revertWindowMs: 60_000,
  maxAutomationsPerSession: 6,
  assumeSilentOnDoubt: true,
}

type ObservationSpec = {
  id: string
  minute: number
  tier: number
  onTask: boolean
  activity: string
  kind: string | null
  driftSeconds: number
  confidence: number
  latencyMs: number
  outcome: string | null
  reason: string
  app: string
  site: string | null
}

// A 40-minute study session: settle in, drift, get a nudge, get spoken to,
// recover, drift once more and finish. Twenty windows, two of them loud.
const OBSERVATIONS: ObservationSpec[] = [
  { id: 'obs_seed_01', minute: 1, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.94, latencyMs: 1180, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_02', minute: 3, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.92, latencyMs: 1240, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_03', minute: 5, tier: 0, onTask: true, activity: 'reading', kind: null, driftSeconds: 0, confidence: 0.9, latencyMs: 1320, outcome: null, reason: 'on_goal', app: 'Safari', site: 'khanacademy.org' },
  { id: 'obs_seed_04', minute: 7, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.93, latencyMs: 1210, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_05', minute: 9, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.91, latencyMs: 1290, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_06', minute: 11, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.88, latencyMs: 1350, outcome: null, reason: 'on_goal', app: 'Notes', site: null },
  { id: 'obs_seed_07', minute: 13, tier: 1, onTask: false, activity: 'browsing', kind: 'social', driftSeconds: 42, confidence: 0.78, latencyMs: 1420, outcome: null, reason: 'ambient_drift', app: 'Safari', site: 'youtube.com' },
  { id: 'obs_seed_08', minute: 15, tier: 2, onTask: false, activity: 'browsing', kind: 'social', driftSeconds: 96, confidence: 0.86, latencyMs: 1500, outcome: 'ignored', reason: 'sustained_drift', app: 'Safari', site: 'youtube.com' },
  { id: 'obs_seed_09', minute: 17, tier: 3, onTask: false, activity: 'browsing', kind: 'video', driftSeconds: 138, confidence: 0.89, latencyMs: 1610, outcome: 'resolved', reason: 'nudge_unresolved', app: 'Safari', site: 'youtube.com' },
  { id: 'obs_seed_10', minute: 19, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.9, latencyMs: 1270, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_11', minute: 21, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.92, latencyMs: 1230, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_12', minute: 23, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.95, latencyMs: 1160, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_13', minute: 25, tier: 0, onTask: true, activity: 'reading', kind: null, driftSeconds: 0, confidence: 0.89, latencyMs: 1300, outcome: null, reason: 'on_goal', app: 'Safari', site: 'ocw.mit.edu' },
  { id: 'obs_seed_14', minute: 27, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.93, latencyMs: 1190, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_15', minute: 29, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.94, latencyMs: 1170, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_16', minute: 31, tier: 0, onTask: true, activity: 'reading', kind: null, driftSeconds: 0, confidence: 0.88, latencyMs: 1340, outcome: null, reason: 'on_goal', app: 'Notes', site: null },
  { id: 'obs_seed_17', minute: 33, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.92, latencyMs: 1220, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_18', minute: 35, tier: 1, onTask: false, activity: 'browsing', kind: 'social', driftSeconds: 38, confidence: 0.74, latencyMs: 1460, outcome: null, reason: 'ambient_drift', app: 'Safari', site: 'news.ycombinator.com' },
  { id: 'obs_seed_19', minute: 37, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.9, latencyMs: 1250, outcome: null, reason: 'on_goal', app: 'Code', site: null },
  { id: 'obs_seed_20', minute: 39, tier: 0, onTask: true, activity: 'working', kind: null, driftSeconds: 0, confidence: 0.93, latencyMs: 1200, outcome: null, reason: 'on_goal', app: 'Code', site: null },
]

function at(minute: number): Date {
  return new Date(SESSION_START.getTime() + minute * 60_000)
}

function makeWindow(spec: ObservationSpec): Prisma.InputJsonValue {
  const focusedSeconds = spec.driftSeconds > 0 ? Math.max(0, 58 - spec.driftSeconds) : 58
  const topApps: Prisma.InputJsonValue = spec.onTask
    ? [{ app: spec.app, seconds: focusedSeconds, onTask: true }]
    : [
        { app: spec.app, seconds: spec.driftSeconds, onTask: false },
        { app: 'Code', seconds: Math.max(0, 58 - spec.driftSeconds), onTask: true },
      ]
  const topSites: Prisma.InputJsonValue = spec.site
    ? [{ title: spec.site, seconds: Math.max(spec.driftSeconds, 12), onTask: spec.onTask }]
    : []

  return {
    from: at(spec.minute - 1).toISOString(),
    to: at(spec.minute).toISOString(),
    windowMs: 60_000,
    focusedSeconds,
    offTaskSeconds: spec.driftSeconds,
    idleSeconds: 0,
    contextSwitches: spec.onTask ? 1 : 4,
    longestFocusRunSeconds: spec.onTask ? 540 : 0,
    inputRate: spec.onTask ? 34.2 : 8.6,
    onTaskRatio: spec.onTask ? 0.97 : 0.12,
    topApps,
    topSites,
    focusMode: false,
    lastFrameRef: `frame_${spec.id}`,
    lastScreenRef: `screen_${spec.id}`,
  }
}

function makeAssessment(spec: ObservationSpec): Prisma.InputJsonValue {
  const evidence = spec.onTask
    ? ['frontmost app: Code', 'input cadence steady']
    : [
        `frontmost app: ${spec.app}`,
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
      ? 'Frontmost app matches the goal and input is steady.'
      : `Frontmost app is off the goal for ${spec.driftSeconds}s.`,
  }
}

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: 'me@heli.local', name: 'Ari' },
    update: { email: 'me@heli.local', name: 'Ari' },
  })

  const goal = await prisma.goal.upsert({
    where: { id: GOAL_ID },
    create: {
      id: GOAL_ID,
      kind: 'study',
      objective: 'Finish the linear algebra problem set',
      successCriteria: 'All 12 problems attempted, with working written up',
      timeBudgetMinutes: 50,
      breakPolicy: 'pomodoro_25_5',
      allowedApps: ['Code', 'Safari', 'Notes', 'Calculator'],
      blockedApps: ['Discord', 'Slack', 'Steam'],
      allowedSites: ['khanacademy.org', 'ocw.mit.edu', 'web.mit.edu'],
      blockedSites: ['youtube.com', 'twitter.com', 'x.com', 'reddit.com'],
      permissions: ['nudge', 'speak'],
      automations: [],
      policy: POLICY,
      active: true,
    },
    update: {
      kind: 'study',
      objective: 'Finish the linear algebra problem set',
      successCriteria: 'All 12 problems attempted, with working written up',
      timeBudgetMinutes: 50,
      breakPolicy: 'pomodoro_25_5',
      allowedApps: ['Code', 'Safari', 'Notes', 'Calculator'],
      blockedApps: ['Discord', 'Slack', 'Steam'],
      allowedSites: ['khanacademy.org', 'ocw.mit.edu', 'web.mit.edu'],
      blockedSites: ['youtube.com', 'twitter.com', 'x.com', 'reddit.com'],
      permissions: ['nudge', 'speak'],
      automations: [],
      policy: POLICY,
      active: true,
    },
  })

  const device = await prisma.device.upsert({
    where: { id: DEVICE_ID },
    create: {
      id: DEVICE_ID,
      code: 'HELI-DEMO',
      name: 'Desk 1',
      caps: { camera: true, mic: true, speaker: true, led: true, ptz: false },
      state: 'idle',
      lastSeenAt: SESSION_END,
      pairedAt: SESSION_START,
      goalId: goal.id,
      userId: user.id,
    },
    update: {
      code: 'HELI-DEMO',
      name: 'Desk 1',
      caps: { camera: true, mic: true, speaker: true, led: true, ptz: false },
      state: 'idle',
      lastSeenAt: SESSION_END,
      goalId: goal.id,
      userId: user.id,
    },
  })

  const tierHistogram: Record<string, number> = {}
  for (const spec of OBSERVATIONS) {
    const key = String(spec.tier)
    tierHistogram[key] = (tierHistogram[key] ?? 0) + 1
  }

  await prisma.session.upsert({
    where: { id: SESSION_ID },
    create: {
      id: SESSION_ID,
      goalId: goal.id,
      deviceId: device.id,
      startedAt: SESSION_START,
      endedAt: SESSION_END,
      summary: {
        durationMs: SESSION_END.getTime() - SESSION_START.getTime(),
        focusedMinutes: 34,
        offTaskMinutes: 6,
        observations: OBSERVATIONS.length,
        interventions: 2,
        longestFocusRunSeconds: 540,
        tierHistogram,
      },
    },
    update: {
      goalId: goal.id,
      deviceId: device.id,
      startedAt: SESSION_START,
      endedAt: SESSION_END,
      summary: {
        durationMs: SESSION_END.getTime() - SESSION_START.getTime(),
        focusedMinutes: 34,
        offTaskMinutes: 6,
        observations: OBSERVATIONS.length,
        interventions: 2,
        longestFocusRunSeconds: 540,
        tierHistogram,
      },
    },
  })

  for (const spec of OBSERVATIONS) {
    const data = {
      sessionId: SESSION_ID,
      ts: at(spec.minute),
      signals: makeWindow(spec),
      assessment: makeAssessment(spec),
      tier: spec.tier,
      action: Prisma.DbNull,
      outcome: spec.outcome,
      confidence: spec.confidence,
      reason: spec.reason,
      latencyMs: spec.latencyMs,
    }

    await prisma.observation.upsert({
      where: { id: spec.id },
      create: { id: spec.id, ...data },
      update: data,
    })
  }

  await prisma.intervention.upsert({
    where: { id: 'int_seed_01' },
    create: {
      id: 'int_seed_01',
      sessionId: SESSION_ID,
      observationId: 'obs_seed_08',
      tier: 2,
      channel: 'notification',
      message: 'Back to the problem set when you get a sec.',
      action: Prisma.DbNull,
      reversible: true,
      outcome: 'ignored',
      reason: 'sustained_drift',
      firedAt: at(15),
      resolvedAt: null,
    },
    update: {
      sessionId: SESSION_ID,
      observationId: 'obs_seed_08',
      tier: 2,
      channel: 'notification',
      message: 'Back to the problem set when you get a sec.',
      action: Prisma.DbNull,
      reversible: true,
      outcome: 'ignored',
      reason: 'sustained_drift',
      firedAt: at(15),
      resolvedAt: null,
    },
  })

  await prisma.intervention.upsert({
    where: { id: 'int_seed_02' },
    create: {
      id: 'int_seed_02',
      sessionId: SESSION_ID,
      observationId: 'obs_seed_09',
      tier: 3,
      channel: 'speech',
      message: "You've been on YouTube for a couple of minutes — the linear algebra set is waiting.",
      action: Prisma.DbNull,
      reversible: true,
      outcome: 'resolved',
      reason: 'nudge_unresolved',
      firedAt: at(17),
      resolvedAt: at(18),
    },
    update: {
      sessionId: SESSION_ID,
      observationId: 'obs_seed_09',
      tier: 3,
      channel: 'speech',
      message: "You've been on YouTube for a couple of minutes — the linear algebra set is waiting.",
      action: Prisma.DbNull,
      reversible: true,
      outcome: 'resolved',
      reason: 'nudge_unresolved',
      firedAt: at(17),
      resolvedAt: at(18),
    },
  })
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`seed failed: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
