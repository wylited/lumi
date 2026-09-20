import type {
  Assessment,
  Goal,
  Intervention,
  Observation,
  Outcome,
  SignalWindow,
} from '@heli/contracts'
import { assess } from './assess.js'
import { decide } from './policy.js'
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
 * `budgetMs` is the hard cap on one pass. It is 15 s, because the cap has been
 * measured against the real provider twice and lost both times.
 *
 * At 6 s it forced `loop.budget_exceeded` and recorded silence on 3 of 8
 * consecutive windows — decisions dropped by a stopwatch rather than by the
 * policy. At 12 s it held for a while, then a window came in at 10.4 s and
 * 10.5 s: the tail is long, because completion length varies with how much the
 * model has to say about the frames (955 tokens on that one). A pass that is
 * still running when the next tick arrives does not overlap it — the loop
 * refuses to start a second pass (`current.inFlight`) — so the cost of a wide
 * budget is a skipped tick, and the cost of a narrow one is a silent window on
 * the demonstration that cannot have one.
 *
 * A late interruption is still better than none.
 */
export const DEFAULT_LOOP_CONFIG: LoopConfig = { budgetMs: 15_000, historyLimit: 20 }

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
}

function freshState(): SessionState {
  return {
    consecutiveOffGoal: 0,
    automationsThisSession: 0,
    lastWindowTo: null,
    pending: null,
    inFlight: false,
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
