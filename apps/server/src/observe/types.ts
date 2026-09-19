import type {
  Assessment,
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

export interface VisionProvider {
  readonly name: VisionProviderName
  assess(input: AssessInput): Promise<Assessment>
}

export interface SpeechProvider {
  readonly name: SpeechProviderName
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>
}

/** Reads the session's latest window and frames. Implemented over Prisma in P1. */
export interface SessionReader {
  window(sessionId: string): Promise<SignalWindow | null>
  frames(sessionId: string): Promise<AssessFrame[]>
  goalFor(sessionId: string): Promise<Goal | null>
  policyFor(sessionId: string): Promise<Policy>
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

export interface LoopDeps {
  clock: Clock
  bus: Bus
  transport: Transport
  vision: VisionProvider
  speech: SpeechProvider
  reader: SessionReader
  writer: ObservationWriter
  /** Tier 4. Returns whether the action was applied. Reversible by contract. */
  automate?: (input: {
    sessionId: string
    action: string
    observationId: string
  }) => Promise<boolean>
  logger: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}
