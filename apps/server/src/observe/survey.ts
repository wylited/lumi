import { ClutterReading } from '@heli/contracts'
import type { DeskSurveyPose, Goal, Observation, SignalWindow } from '@heli/contracts'

import type { SurveyTrigger } from './policy.js'
import type {
  Bus,
  Clock,
  DeskIssuer,
  LoopDeps,
  ObservationWriter,
  SessionReader,
  VisionProvider,
} from './types.js'

/**
 * The survey pass: the loop's second, rarer reading.
 *
 *   sweep the desk → read the frames the sweep named → one model call → one row
 *
 * It is thin the way `assess.ts` is thin: ask the desk, hold the model's answer to
 * the frozen schema, write what came back. The orchestrator owns *when* a sweep
 * happens and what the reading is worth; this file owns the pass itself, and every
 * seam (desk, reader, writer, vision, bus, clock) is injected, so the whole thing
 * runs in a test with no rig, no database and no key.
 *
 * It is deliberately **outside** the 6 s window budget: a sweep takes seconds of
 * arm time before the model is even called, and it must never make a window late.
 * Its own cap is `SURVEY_BUDGET_MS`, around the model call alone.
 */

/** The model call's hard cap. The rig's own sweep cap (20 s) sits outside this. */
export const SURVEY_BUDGET_MS = 20_000

/**
 * Why no reading came back.
 *
 * The loop's own refusals are `gap` and `busy` (decided before a sweep is asked
 * for) and `no_desk`, `no_frames`, `assess_failed` (decided during it). When the
 * **rig** is what refused, its own code is passed through instead —
 * `survey_unavailable`, `no_frame`, `survey_timeout`, `desk_offline`,
 * `ack_timeout` — because the desk panel has copy for exactly those, and
 * flattening them into one word would hide what actually happened.
 */
export interface SurveyOutcome {
  reading: ClutterReading
  /** The poses the rig reported, in sweep order. */
  poses: DeskSurveyPose[]
  observation: Observation
}

export type SurveyAttempt = ({ ok: true } & SurveyOutcome) | { ok: false; reason: string }

export interface SurveyPassInput {
  sessionId: string
  /**
   * Why the sweep is being taken. `manual` is not a due reason but it is a real
   * one: a person pressed the button, and the rig's log, the action log and the
   * reading's own `reason` should say so rather than dress it up as a `floor`.
   */
  trigger: SurveyTrigger | 'manual'
  goal: Goal
  window: SignalWindow
  desk: DeskIssuer
  reader: SessionReader
  writer: ObservationWriter
  vision: VisionProvider
  bus: Bus
  clock: Clock
  logger: LoopDeps['logger']
  /** How many poses to ask the rig for: 1 is a still from where the camera is. */
  poses: number
}

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/**
 * The model call, capped.
 *
 * A local copy of the loop's guard on purpose: the pass must be able to run
 * without the loop module (the loop imports this one), and the timer is cleared
 * on settle so a fast call never leaves the process holding a 20 s handle.
 */
function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`exceeded ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}

/**
 * One sweep, from the action to the row.
 *
 * The order matters and is the whole contract: the rig is asked first (nothing
 * else can happen without its ack), the frames are read **by the seqs that ack
 * named** — never "whatever `survey` holds now", so a second sweep cannot mix
 * into this one — then one model call, one row, one event. A refusal anywhere
 * before the model call costs nothing; a refusal after it still writes nothing,
 * because a reading we could not hold to `ClutterReading` is not a reading.
 */
export async function surveyDesk(input: SurveyPassInput): Promise<SurveyAttempt> {
  const { sessionId, trigger, logger } = input
  const started = input.clock.now()

  const desk = await input.desk.theDesk()
  if (desk === null) {
    logger.info({ sessionId, trigger }, 'survey.skip: no desk')
    return { ok: false, reason: 'no_desk' }
  }

  const record = await input.desk.issue(desk.id, {
    type: 'desk.survey',
    payload: { reason: `survey:${trigger}`, poses: input.poses },
  })

  const swept = record.status === 'done' ? (record.result?.survey ?? null) : null
  if (swept === null) {
    // The rig's own word for what went wrong is the most useful reason the caller
    // can hear, so it is passed through rather than replaced with a guess; a
    // record with no error at all (a `done` ack that reported no sweep) is the
    // one case where there were, plainly, no frames.
    logger.warn(
      { sessionId, trigger, status: record.status, error: record.error },
      'survey.failed',
    )
    return { ok: false, reason: record.error ?? 'no_frames' }
  }

  const frames = await input.reader.surveyFrames(
    sessionId,
    swept.poses.map((pose) => pose.seq),
  )
  if (frames.length === 0) {
    logger.info({ sessionId, trigger, seqs: swept.poses.map((pose) => pose.seq) }, 'survey.skip: no frames')
    return { ok: false, reason: 'no_frames' }
  }

  let reading: ClutterReading
  try {
    const proposed = await withinBudget(
      input.vision.survey({ goal: input.goal, window: input.window, frames }),
      SURVEY_BUDGET_MS,
    )
    const parsed = ClutterReading.safeParse(proposed)
    if (!parsed.success) {
      throw new Error(`the provider's reading is not a ClutterReading: ${parsed.error.message}`)
    }
    reading = parsed.data
  } catch (error) {
    // A throw and a shape we cannot read are the same thing here: no reading, and
    // the next window is silence rather than a guess.
    logger.warn({ sessionId, trigger, error }, 'survey.assess_failed')
    return { ok: false, reason: 'assess_failed' }
  }

  const observation = await input.writer.write({
    sessionId,
    window: input.window,
    // A survey is not a window: no assessment, tier 0, no intervention. It is a
    // reading kept on its own row, which is why the live view can filter on it.
    assessment: null,
    tier: 0,
    action: null,
    outcome: null,
    confidence: reading.confidence,
    reason: `survey:clutter:${reading.score.toFixed(2)}`,
    latencyMs: input.clock.now() - started,
    survey: reading,
  })

  input.bus.publish(sessionId, { event: 'observation', data: observation })

  logger.info(
    {
      sessionId,
      trigger,
      poses: swept.poses.length,
      // How many poses went through the calibration: a sweep with no `aim` cannot
      // be pointed at, which is what the physical gesture depends on.
      withAim: swept.poses.filter((pose) => pose.aim !== null).length,
      durationMs: swept.durationMs,
    },
    'survey.sweep',
  )

  return { ok: true, reading, poses: swept.poses, observation }
}
