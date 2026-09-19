import type { Assessment, SignalWindow } from '@heli/contracts'

import type { AssessInput, VisionProvider } from '../observe/types.js'

/** Fixed so fixtures and tests are reproducible with no key. */
export const LOCAL_CONFIDENCE = 0.8
export const LOCAL_ON_TASK_RATIO = 0.6

function topOffTask(apps: SignalWindow['topApps']): string | null {
  const off = apps
    .filter((entry) => !entry.onTask)
    .sort((a, b) => b.seconds - a.seconds)
  return off[0]?.app ?? null
}

function topOffTaskSite(sites: SignalWindow['topSites']): string | null {
  const off = sites
    .filter((entry) => !entry.onTask)
    .sort((a, b) => b.seconds - a.seconds)
  return off[0]?.title ?? null
}

/**
 * Deterministic, keyless assessment derived only from the window's own metrics.
 * No frames, no randomness, no clock. The same window always yields the same
 * Assessment so the loop and the fixtures are honest without a model.
 */
export function assessLocally(input: AssessInput): Assessment {
  const w = input.window

  const onTask = w.onTaskRatio >= LOCAL_ON_TASK_RATIO

  const windowSeconds = w.windowMs / 1000
  const idleRatio = windowSeconds > 0 ? w.idleSeconds / windowSeconds : 0
  const idleThreshold = Math.min(30, windowSeconds * 0.3)

  let activity: string
  if (idleRatio >= 0.8) {
    activity = 'away'
  } else if (w.idleSeconds >= idleThreshold && w.inputRate < 1) {
    activity = 'idle'
  } else if (w.inputRate >= 6) {
    activity = 'working'
  } else {
    activity = 'reading'
  }

  const distractionApp = topOffTask(w.topApps)
  const kind = onTask ? null : (distractionApp ?? topOffTaskSite(w.topSites) ?? 'off-task')

  const driftSeconds = Math.round(w.offTaskSeconds)
  const onTaskPercent = Math.round(w.onTaskRatio * 100)

  const evidence = [
    `onTaskRatio ${w.onTaskRatio.toFixed(2)}`,
    `inputRate ${w.inputRate}/30s`,
    `offTask ${driftSeconds}s, idle ${Math.round(w.idleSeconds)}s`,
  ]

  const because = onTask
    ? `Focused ${onTaskPercent}% of the window at ${w.inputRate}/30s input.`
    : `${driftSeconds}s off task${distractionApp ? ` in ${distractionApp}` : ''}, ${onTaskPercent}% on goal.`

  return {
    onTask,
    activity,
    kind,
    driftSeconds,
    evidence,
    confidence: LOCAL_CONFIDENCE,
    because,
  }
}

export function createLocalVisionProvider(): VisionProvider {
  return {
    name: 'local',
    assess: async (input: AssessInput): Promise<Assessment> => assessLocally(input),
  }
}
