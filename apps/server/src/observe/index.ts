import type {
  Assessment,
  ClutterReading,
  DeskSurveyPose,
  Goal,
  Intervention,
  Observation,
  Outcome,
  SignalWindow,
} from '@heli/contracts'
import { assess } from './assess.js'
import { SURVEY, decide, surveyDue, type SurveyTrigger } from './policy.js'
import { surveyDesk, type SurveyAttempt } from './survey.js'
import { buildSummary } from './summary.js'
import type { LoopDeps } from './types.js'
import { deliverIntervention } from '../voice/push.js'

/**
 * The orchestrator. One pass over one session's window:
 *
 *   window → assess → policy → act → persist → publish
 *
 * It owns the cadence, the hard budget, the per-session counters and the
 * outcome of the previous intervention. Every seam (reader, writer, bus,
 * transport, providers) is injected, so this file runs in a test with no
 * database, no network and no key.
 */
export interface LoopConfig {
  /** Hard cap on one pass. Past it we record silence rather than a late action. */
  budgetMs: number
  /** How many recent interventions the policy may look at. */
  historyLimit: number
}

/**
 * `budgetMs` is the hard cap on one pass. It is 6 s rather than 4 s because a
 * hosted vision call that also reads an image lands around 4–6 s, and a late
 * interruption is worse than none — past the cap we record silence.
 */
export const DEFAULT_LOOP_CONFIG: LoopConfig = { budgetMs: 6000, historyLimit: 20 }

export interface WindowResult {
  observationId: string
  tier: number
  onTask: boolean | null
  reason: string | null
  intervention: Intervention | null
  delivered: boolean
  latencyMs: number
}

export interface Loop {
  /** Assess one session's newest window. Idempotent per window; overlapping calls skip. */
  runWindow(sessionId: string): Promise<WindowResult | null>
  /**
   * Sweep the desk and read the clutter, or explain why not.
   *
   * It **never rejects**, so the scheduler can fire it without waiting and the
   * manual route can answer with it, and it refuses its own overlap. `trigger`
   * overrides the due table when a route asks by hand (`'manual'`); the gap still
   * applies to that, because the gap is what keeps one sweep from becoming three.
   */
  runSurvey(sessionId: string, trigger?: SurveyTrigger | 'manual'): Promise<SurveyAttempt>
  /** Forget a session's in-memory counters, for example when it closes. */
  reset(sessionId?: string): void
  /** The tier-5 artifact. P1 persists it; the loop only knows how to build it. */
  summarize(input: Parameters<typeof buildSummary>[0]): ReturnType<typeof buildSummary>
}

interface SessionState {
  consecutiveOffGoal: number
  automationsThisSession: number
  lastWindowTo: string | null
  pending: { observationId: string; tier: number; kind: string | null } | null
  inFlight: boolean
  /** `runSurvey` guards its own overlap: one sweep at a time per session. */
  surveyInFlight: boolean
  lastSurveyAt: number | null
  /** Whether that sweep was the away one, so one absence earns one sweep. */
  lastSurveyAway: boolean
  /** Whether a desk line has already come with a physical point this session. */
  pointedThisSession: boolean
  /** Set when a sweep found the desk, so the point has an address without a second query. */
  deskId: string | null
  /** The newest reading, until a newer sweep replaces it. */
  clutter: { reading: ClutterReading; at: number; poses: DeskSurveyPose[] } | null
  /**
   * The last desk **line**: the score the next one has to beat, and the time both
   * of its gaps run from. It lives beside the reading it spoke about rather than
   * in the rows, because it is the same lifetime: the rule compares against a
   * reading the session still holds, and after a restart there is no `clutter`, so
   * a memory that outlived it would guard nothing.
   */
  clutterSpoken: { at: number; score: number } | null
}

function freshState(): SessionState {
  return {
    consecutiveOffGoal: 0,
    automationsThisSession: 0,
    lastWindowTo: null,
    pending: null,
    inFlight: false,
    surveyInFlight: false,
    lastSurveyAt: null,
    lastSurveyAway: false,
    pointedThisSession: false,
    deskId: null,
    clutter: null,
    clutterSpoken: null,
  }
}

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
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

function pendingOutcome(assessment: Assessment | null): Outcome {
  if (!assessment) return 'unknown'
  return assessment.onTask ? 'resolved' : 'ignored'
}

export function createLoop(deps: LoopDeps, config: LoopConfig = DEFAULT_LOOP_CONFIG): Loop {
  const sessions = new Map<string, SessionState>()

  function state(sessionId: string): SessionState {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const created = freshState()
    sessions.set(sessionId, created)
    return created
  }

  async function runWindow(sessionId: string): Promise<WindowResult | null> {
    const current = state(sessionId)
    if (current.inFlight) {
      deps.logger.info({ sessionId }, 'loop.skip: pass already in flight')
      return null
    }
    current.inFlight = true
    const started = deps.clock.now()

    try {
      const window = await deps.reader.window(sessionId)
      if (!window) {
        deps.logger.info({ sessionId }, 'loop.skip: no window yet')
        return null
      }
      if (window.to === current.lastWindowTo) {
        deps.logger.info({ sessionId, to: window.to }, 'loop.skip: window already assessed')
        return null
      }

      // One absence earns one sweep, so the latch has to clear as soon as the
      // window finds the person back: without this the *first* absence of a
      // session spends the latch and a second one, later in the same session,
      // never earns a sweep of its own.
      if (window.idleSeconds < SURVEY.awayIdleSeconds) current.lastSurveyAway = false

      const goal = await deps.reader.goalFor(sessionId)
      if (!goal) {
        deps.logger.warn({ sessionId }, 'loop.skip: no goal')
        return null
      }

      const now = deps.clock.now()
      const remaining = Math.max(250, config.budgetMs - (now - started))
      let assessment: Assessment | null = null
      // A provider that errors is `assess_failed`; one that runs out of budget is
      // `budget_exceeded`. They are different failures and the console says which.
      let timedOut = false
      try {
        assessment = await withBudget(
          assess(
            { window, goal, frames: await deps.reader.frames(sessionId) },
            { vision: deps.vision, logger: deps.logger },
          ),
          remaining,
        )
      } catch (error) {
        // Either the watchdog fired, or the call failed after we had already
        // spent the budget. Both are the budget's fault and both are silence.
        timedOut =
          (error as { name?: string } | null)?.name === 'TimeoutError' ||
          deps.clock.now() - started >= config.budgetMs
        deps.logger.warn({ sessionId, timedOut, error }, 'loop.assess_failed: staying silent')
      }

      await resolvePending(sessionId, assessment, started)

      const offGoal = assessment ? !assessment.onTask : false
      // The trailing off-goal count comes from the rows, so a restart or a second
      // worker does not reset the ladder.
      const prior = await deps.writer.consecutiveOffGoal(sessionId)
      current.consecutiveOffGoal = offGoal ? prior + 1 : 0

      // The desk's newest reading, if a sweep has landed one. The two speech
      // values come from the last desk **line** rather than the last line of any
      // kind: the clutter gap and the "worse than last time" rule are about what
      // we already said about the desk, and the loop remembers that itself.
      const stashed = current.clutter

      const intervention = assessment
        ? decide({
            assessment,
            window,
            goal,
            now: deps.clock.now(),
            lastSpokenAt: await deps.writer.lastSpokenAt(sessionId),
            lastNudgeAt: await deps.writer.lastNudgeAt(sessionId),
            consecutiveOffGoal: current.consecutiveOffGoal,
            automationsThisSession: current.automationsThisSession,
            recentOutcomes: await deps.writer.recentOutcomes(sessionId, config.historyLimit),
            clutter: stashed
              ? {
                  reading: stashed.reading,
                  at: stashed.at,
                  poses: stashed.poses.map((pose) => ({ aim: pose.aim })),
                  lastSpokenAt: current.clutterSpoken?.at ?? null,
                  lastSpokenScore: current.clutterSpoken?.score ?? null,
                  pointedThisSession: current.pointedThisSession,
                }
              : null,
          })
        : null

      const elapsedBeforeWrite = deps.clock.now() - started
      const overBudget = elapsedBeforeWrite > config.budgetMs || timedOut
      const finalIntervention = overBudget ? null : intervention
      if (overBudget) {
        deps.logger.warn(
          { sessionId, latencyMs: elapsedBeforeWrite, budgetMs: config.budgetMs },
          'loop.budget_exceeded: forced silence',
        )
      }

      const { delivered, observation } = await act({
        sessionId,
        goal,
        window,
        assessment,
        intervention: finalIntervention,
        overBudget,
        timedOut,
        latencyMs: deps.clock.now() - started,
      })

      current.lastWindowTo = window.to

      // The desk line has just gone out, so the next one has to beat it. Its
      // identity is its **reason**: the drift ladder can also speak at tier 3, so
      // the tier and the channel cannot tell the two apart, and the vocabulary
      // `clutterDecision` emits is the one thing that can. Stamped next to the
      // reading it spoke about, which is what the rule compares against.
      if (finalIntervention?.reason?.startsWith('tier3:speak:clutter') && stashed) {
        current.clutterSpoken = { at: deps.clock.now(), score: stashed.reading.score }
      }

      // A desk line that came with a place to point at. The line has already been
      // delivered and the row written, so the gesture is issued **detached**: a
      // sweep that fails to move the arm is a log line, never a lost
      // intervention, and the window never waits on the rig.
      const point = finalIntervention?.point ?? null
      if (point) {
        current.pointedThisSession = true
        const desk = deps.desk
        const deskId = current.deskId
        if (desk && deskId !== null) {
          void desk
            .issue(deskId, { type: 'arm.point', payload: point })
            .then((record) => {
              deps.logger.info(
                { sessionId, deskId, status: record.status, error: record.error },
                'loop.point',
              )
            })
            .catch((error: unknown) => {
              deps.logger.warn({ sessionId, deskId, error }, 'loop.point_failed')
            })
        } else {
          // No desk lookup was cached, so there is nowhere to send the gesture.
          // The line stands; only the point is lost, and it is said out loud.
          deps.logger.warn({ sessionId }, 'loop.point_skipped: no desk to point with')
        }
      }

      if (finalIntervention && finalIntervention.tier >= 2) {
        current.pending = {
          observationId: observation.id,
          tier: finalIntervention.tier,
          kind: assessment?.kind ?? null,
        }
      }
      if (finalIntervention?.tier === 4) current.automationsThisSession += 1

      deps.bus.publish(sessionId, { event: 'signal.window', data: window })
      deps.bus.publish(sessionId, { event: 'observation', data: observation })
      if (finalIntervention && finalIntervention.tier >= 2) {
        deps.bus.publish(sessionId, { event: 'intervention', data: finalIntervention })
      }

      return {
        observationId: observation.id,
        tier: finalIntervention?.tier ?? 0,
        onTask: assessment ? assessment.onTask : null,
        reason: observation.reason,
        intervention: finalIntervention,
        delivered,
        latencyMs: observation.latencyMs ?? 0,
      }
    } finally {
      current.inFlight = false
    }
  }

  /**
   * The desk survey, asked for by the tick or by a hand.
   *
   * The loop's job here is *whether*: the desk has to be there, the sweep has to
   * be due (or asked for), and the gap applies to every caller — a person
   * pressing the button three times must not move the arm three times. The pass
   * itself (`surveyDesk`) owns the rest.
   *
   * It never rejects: an unexpected throw becomes an `assess_failed` attempt and
   * a log line, which is what lets the scheduler fire it without awaiting it.
   */
  async function runSurvey(
    sessionId: string,
    requested?: SurveyTrigger | 'manual',
  ): Promise<SurveyAttempt> {
    const current = state(sessionId)
    if (current.surveyInFlight) {
      deps.logger.info({ sessionId }, 'survey.skip: a sweep is already in flight')
      return { ok: false, reason: 'busy' }
    }
    current.surveyInFlight = true
    const started = deps.clock.now()

    try {
      const window = await deps.reader.window(sessionId)
      if (!window) {
        // No window means no signals yet, and a sweep would have nothing to write
        // its reading onto.
        deps.logger.info({ sessionId }, 'survey.skip: no window yet')
        return { ok: false, reason: 'no_frames' }
      }

      const issuer = deps.desk
      const desk = await issuer?.theDesk()
      if (!issuer || !desk || !desk.connected) {
        deps.logger.info({ sessionId, requested }, 'survey.skip: no desk')
        return { ok: false, reason: 'no_desk' }
      }
      // Cached now rather than looked up again when a point has to be sent: the
      // desk that answered this sweep is the desk the gesture belongs to.
      current.deskId = desk.id

      const policy = await deps.reader.policyFor(sessionId)

      let trigger: SurveyTrigger | 'manual'
      if (requested !== undefined) {
        // A caller that knows why wins over the due table.
        trigger = requested
      } else {
        const sessionStartedAt = await deps.reader.sessionStartedAt(sessionId)
        if (sessionStartedAt === null) {
          deps.logger.warn({ sessionId }, 'survey.skip: no session start')
          return { ok: false, reason: 'gap' }
        }
        const due = surveyDue({
          now: started,
          idleSeconds: window.idleSeconds,
          sessionStartedAt,
          lastSurveyAt: current.lastSurveyAt,
          lastSurveyAway: current.lastSurveyAway,
          deskConnected: desk.connected,
          policy,
        })
        if (due === null) {
          // "Not due" is the normal answer on a tick, so it is not logged — one
          // line every ten seconds per session would be noise. The caller hears
          // the same word the gap gives, because it means the same thing: not
          // now.
          return { ok: false, reason: 'gap' }
        }
        trigger = due
      }

      // The gap is the loop's rule, not the rig's, and it binds the hand as well
      // as the tick: one sweep per `surveyGapMs`, whoever asked. `surveyDue`
      // already refuses inside it, so the line that lands here is a person
      // pressing the button a minute after the last sweep.
      if (current.lastSurveyAt !== null && started - current.lastSurveyAt < policy.surveyGapMs) {
        deps.logger.info(
          { sessionId, sinceLastMs: started - current.lastSurveyAt, gapMs: policy.surveyGapMs },
          'survey.skip: gap',
        )
        return { ok: false, reason: 'gap' }
      }

      const goal = await deps.reader.goalFor(sessionId)
      if (!goal) {
        deps.logger.warn({ sessionId }, 'survey.skip: no goal')
        return { ok: false, reason: 'no_frames' }
      }

      // The start reading is one frame from where the camera already points:
      // moving the arm across the desk two minutes after someone sat down is a
      // gesture nobody asked for. Away, floor and hand all get the sweep, and a
      // rig with no arm takes a single frame whatever the reason.
      const poses = trigger === 'start' ? 1 : desk.hasArm ? 3 : 1

      const attempt = await surveyDesk({
        sessionId,
        trigger,
        goal,
        window,
        desk: issuer,
        reader: deps.reader,
        writer: deps.writer,
        vision: deps.vision,
        bus: deps.bus,
        clock: deps.clock,
        logger: deps.logger,
        poses,
      })

      const finished = deps.clock.now()
      // The gap binds attempts, not successes. Keyed on a reading, a rig that
      // refuses every sweep — offline, no frames, a model that will not answer —
      // leaves `lastSurveyAt` untouched, and `surveyDue` then reads a session that
      // has never been read as due for a `start` sweep on *every* window: 20 s of
      // arm time and a model call per tick, forever. A refused sweep was still a
      // sweep that was asked for.
      current.lastSurveyAt = started

      if (attempt.ok) {
        current.clutter = { reading: attempt.reading, at: finished, poses: attempt.poses }
        // One sweep per absence means one sweep that happened: a refusal is not
        // one, so the next away window may try again — inside the gap.
        current.lastSurveyAway = trigger === 'away'
        deps.logger.info(
          {
            sessionId,
            trigger,
            poses: attempt.poses.length,
            score: attempt.reading.score,
            hotspots: attempt.reading.hotspots.length,
            confidence: attempt.reading.confidence,
            latencyMs: finished - started,
          },
          'observe.survey',
        )
      }

      return attempt
    } catch (error) {
      // Never reject: the scheduler fires this without awaiting it, and the
      // manual route answers with whatever it returns.
      deps.logger.error({ sessionId, error }, 'survey.failed: unexpected error')
      return { ok: false, reason: 'assess_failed' }
    } finally {
      current.surveyInFlight = false
    }
  }

  /** The previous window's intervention is judged by this window's assessment. */
  async function resolvePending(
    sessionId: string,
    assessment: Assessment | null,
    started: number,
  ): Promise<void> {
    const current = state(sessionId)
    if (!current.pending) return
    const outcome = pendingOutcome(assessment)
    try {
      await deps.writer.markOutcome(current.pending.observationId, outcome)
    } catch (error) {
      deps.logger.warn({ sessionId, error }, 'loop.mark_outcome_failed')
    }
    deps.logger.info(
      { sessionId, tier: current.pending.tier, outcome, latencyMs: deps.clock.now() - started },
      'loop.outcome',
    )
    current.pending = null
  }

  async function act(input: {
    sessionId: string
    goal: Goal
    window: SignalWindow
    assessment: Assessment | null
    intervention: Intervention | null
    overBudget: boolean
    timedOut: boolean
    latencyMs: number
  }): Promise<{ delivered: boolean; observation: Observation }> {
    const { sessionId, goal, window, assessment, intervention, overBudget, timedOut, latencyMs } =
      input
    let delivered = false

    if (intervention && intervention.tier >= 2) {
      if (intervention.tier === 4 && intervention.action) {
        if (deps.automate) {
          try {
            delivered = await deps.automate({
              sessionId,
              action: intervention.action,
              observationId: 'pending',
              target: offGoalTarget(window),
              message: intervention.message || 'Changed something your goal allows.',
            })
          } catch (error) {
            deps.logger.error({ sessionId, error }, 'loop.automate_failed')
          }
        } else {
          deps.logger.warn({ sessionId }, 'loop.automate_skipped: no handler wired')
        }
      } else {
        const result = await deliverIntervention({
          intervention,
          sessionId,
          language: 'en',
          speech: deps.speech,
          transport: deps.transport,
          clock: deps.clock,
          logger: deps.logger,
        })
        delivered = result.delivered
      }
    }

    const reason = overBudget
      ? 'tier0:budget_exceeded'
      : timedOut
        ? 'tier0:budget_exceeded'
        : (intervention?.reason ?? (assessment ? 'tier0:silent' : 'assess_failed'))

    const observation = await deps.writer.write({
      sessionId,
      window,
      assessment,
      tier: intervention?.tier ?? 0,
      action: intervention,
      outcome: null,
      confidence: assessment?.confidence ?? null,
      reason,
      latencyMs,
    })

    deps.logger.info(
      {
        sessionId,
        goal: goal.id,
        tier: observation.tier,
        onTask: assessment ? assessment.onTask : null,
        confidence: assessment?.confidence ?? null,
        delivered,
        latencyMs,
      },
      'loop.window',
    )

    return { delivered, observation }
  }

  return {
    runWindow,
    runSurvey,
    reset(sessionId?: string) {
      if (sessionId) sessions.delete(sessionId)
      else sessions.clear()
    },
    summarize: buildSummary,
  }
}

/** What the window was off the goal on, for tier 4 to act on: the top off-goal site, else app. */
export function offGoalTarget(window: SignalWindow): string | null {
  const site = window.topSites.filter((s) => !s.onTask).sort((a, b) => b.seconds - a.seconds)[0]
  if (site) return site.title
  const app = window.topApps.filter((a) => !a.onTask).sort((a, b) => b.seconds - a.seconds)[0]
  return app?.app ?? null
}
