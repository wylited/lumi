import type { Goal, LiveEvent, Observation, Session } from '@heli/contracts'
import { DEVICE_ID, buildSession } from './build.js'
import { type WindowSpec, proceduralStory, seedStory } from './story.js'

export type LiveScenario = 'drifting' | 'focused'

export interface LiveFeedOptions {
  goal: Goal
  scenario?: LiveScenario
  /** Wall-clock ms per one-minute window. The demo runs time fast; 60 000 is real time. */
  tickMs?: number
  onEvent: (event: LiveEvent) => void
}

export interface LiveFeed {
  session: Session
  /** Every observation emitted so far, oldest first. */
  history: () => Observation[]
  stop: () => void
}

/**
 * The same `LiveEvent` stream the SSE channel sends, generated locally. `drifting` replays the
 * seeded story (a drift, a nudge that fails, a spoken line that lands); `focused` is quiet on
 * purpose — silence is the result.
 */
export function createLiveFeed({
  goal,
  scenario = 'drifting',
  tickMs = 3000,
  onEvent,
}: LiveFeedOptions): LiveFeed {
  const script: WindowSpec[] =
    scenario === 'drifting' ? seedStory() : proceduralStory(99, 40).map(quiet)
  // Start a few windows in so the first paint already has a shape.
  const warm = 6
  const now = Date.now()
  const start = new Date(now - warm * tickMs)
  const id = `sess_live_${Math.floor(now / 1000).toString(36)}`
  const session: Session = {
    id,
    deviceId: DEVICE_ID,
    goalId: goal.id,
    startedAt: start.toISOString(),
    endedAt: null,
    durationMs: null,
    signalCount: 0,
    observationCount: 0,
    interventionCount: 0,
    tierHistogram: {},
    summary: null,
  }

  const emitted: Observation[] = []
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function step(): void {
    const spec = script[cursor % script.length] as WindowSpec
    const lap = Math.floor(cursor / script.length)
    const minute = cursor + 1
    // Build this window with the next one in view, so outcomes read the way the policy judges them.
    const pair = [
      { ...spec, minute },
      { ...(script[(cursor + 1) % script.length] as WindowSpec), minute: minute + 1 },
    ]
    const built = buildSession(id, start, pair, goal, { live: true }).detail
    const obs = built.observations[0] as Observation
    const ts = new Date(start.getTime() + minute * tickMs).toISOString()
    const observation: Observation = {
      ...obs,
      id: `${id}_obs_${lap}_${minute}`,
      ts,
      signals: { ...obs.signals, to: ts, from: new Date(Date.parse(ts) - 60_000).toISOString() },
    }

    emitted.push(observation)
    onEvent({ event: 'signal.window', data: observation.signals })
    onEvent({ event: 'observation', data: observation })
    if (observation.action) onEvent({ event: 'intervention', data: observation.action })
    onEvent({
      event: 'state',
      data: {
        sessionId: id,
        deviceState:
          observation.tier >= 3 ? 'speaking' : observation.tier >= 1 ? 'flagged' : 'watching',
        media: null,
      },
    })
    cursor += 1
  }

  for (let i = 0; i < warm; i += 1) step()
  timer = setInterval(step, tickMs)

  return {
    session,
    history: () => emitted.slice(),
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

function quiet(spec: WindowSpec): WindowSpec {
  return spec.onTask
    ? spec
    : {
        ...spec,
        onTask: true,
        tier: 0,
        kind: null,
        driftSeconds: 0,
        offTaskSeconds: 12,
        reason: 'on_goal',
        activity: 'working',
        app: 'Code',
        site: null,
      }
}
