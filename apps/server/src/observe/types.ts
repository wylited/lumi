import type {
  Assessment,
  ClutterReading,
  DeskActionRecord,
  Goal,
  LiveEvent,
  Observation,
  Outcome,
  Policy,
  SignalWindow,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechProviderName,
  VisionProviderName,
} from '@heli/contracts'

/**
 * The seams the loop is built against. Everything below is injected, so the
 * loop, the policy and the tests run with no server, no database and no key.
 */

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** Where observations and interventions are published for SSE. */
export interface Bus {
  publish(sessionId: string, event: LiveEvent): void
}

/** Delivering a line to a speaker. The desktop owns the speaker; the desk may too. */
export interface Transport {
  /** Returns whether the line played. A false ack is recorded as unacknowledged, never assumed. */
  deliverLine(input: {
    sessionId: string
    text: string
    hintLevel: number
    audio: SpeechSynthesisResult
    momentId: string | null
  }): Promise<{ delivered: boolean; acknowledged: boolean }>
  /** Tier 2. Returns whether a notification with an action was shown. */
  nudge(input: { sessionId: string; message: string }): Promise<boolean>
}

/** A frame the model may look at, already fetched by the orchestrator. */
export interface AssessFrame {
  kind: 'desk' | 'screen'
  ref: string
  mediaType: 'image/jpeg'
  bytes: Buffer | null
  width: number | null
  height: number | null
}

export interface AssessInput {
  window: SignalWindow
  goal: Goal
  frames: AssessFrame[]
}

/** One sweep of the desk: the frames are in sweep order, left of the desk first. */
export interface SurveyInput {
  window: SignalWindow
  goal: Goal
  frames: AssessFrame[]
}

export interface VisionProvider {
  readonly name: VisionProviderName
  assess(input: AssessInput): Promise<Assessment>
  /** The rarer reading: how cluttered the desk is, judged on the surface alone. */
  survey(input: SurveyInput): Promise<ClutterReading>
}

export interface SpeechProvider {
  readonly name: SpeechProviderName
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>
}

/** Reads the session's latest window and frames. Implemented over Prisma in P1. */
export interface SessionReader {
  window(sessionId: string): Promise<SignalWindow | null>
  frames(sessionId: string): Promise<AssessFrame[]>
  /**
   * The frames of one sweep, in sweep order. The seqs come from the rig's own
   * ack, so this reads exactly the frames that sweep named rather than whatever
   * the `survey` ring holds now — a later sweep must not be able to mix into it.
   */
  surveyFrames(sessionId: string, seqs: number[]): Promise<AssessFrame[]>
  goalFor(sessionId: string): Promise<Goal | null>
  policyFor(sessionId: string): Promise<Policy>
  /** When the session began, for the survey's start delay. Null when the row is gone. */
  sessionStartedAt(sessionId: string): Promise<number | null>
}

/** Writes back what happened. Implemented over Prisma in P1. */
export interface ObservationWriter {
  write(input: {
    sessionId: string
    window: SignalWindow
    assessment: Assessment | null
    tier: number
    /** The Intervention that fired, or null for silence. */
    action: unknown | null
    outcome: Outcome | null
    confidence: number | null
    reason: string | null
    latencyMs: number
    /** The desk survey's reading, on a survey row; null on every window row. */
    survey?: ClutterReading | null
  }): Promise<Observation>
  /** The previous intervention's verdict, written when the next window judges it. */
  markOutcome(observationId: string, outcome: Outcome): Promise<void>
  /** The outcome of recent interventions, so the policy can adapt. */
  recentOutcomes(sessionId: string, limit: number): Promise<{
    tier: number
    kind: string | null
    outcome: string
  }[]>
  /** Derived from written observations: the newest tier-3 row. */
  lastSpokenAt(sessionId: string): Promise<number | null>
  /** Derived from written observations: the newest tier-2 row. */
  lastNudgeAt(sessionId: string): Promise<number | null>
  /**
   * How many trailing windows were off task, read from the rows. Derived rather
   * than held in memory so a restart does not reset the escalation ladder.
   */
  consecutiveOffGoal(sessionId: string): Promise<number>
}

/**
 * The desk, as the survey pass needs it: which one is there, and how to make it
 * move.
 *
 * `theDesk` is a call rather than a value because the rig registers itself and
 * reconnects, and a sweep is rare enough that asking each time is cheaper than
 * keeping an answer fresh. `issue` returns the action **record** rather than the
 * sweep's poses, so the pass holds the same ack the panel and the action log do —
 * including the `error` when the rig refused.
 */
export interface DeskIssuer {
  theDesk(): Promise<{ id: string; connected: boolean; hasArm: boolean } | null>
  issue(
    deskId: string,
    request: { type: string; payload: Record<string, unknown> },
  ): Promise<DeskActionRecord>
}

export interface LoopDeps {
  clock: Clock
  bus: Bus
  transport: Transport
  vision: VisionProvider
  speech: SpeechProvider
  reader: SessionReader
  writer: ObservationWriter
  /** The rig, for the desk survey and the point that follows one. Absent in a test. */
  desk?: DeskIssuer
  /** Tier 4. Returns whether the action was applied. Reversible by contract. */
  automate?: (input: {
    sessionId: string
    action: string
    observationId: string
    /** The site, else the app, the window spent most off-goal time on; null when none. */
    target: string | null
    message: string
  }) => Promise<boolean>
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}
