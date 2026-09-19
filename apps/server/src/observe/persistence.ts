import {
  Assessment,
  DEFAULT_POLICY,
  Goal,
  Observation,
  type Goal as GoalContract,
  type Intervention,
  type Outcome,
  type Policy,
  type SignalWindow,
} from '@heli/contracts'

import { prisma as defaultPrisma } from '../lib/prisma.js'
import type { ObjectRef } from '../lib/storage.js'
import { getWindow } from '../services/signals.js'
import { getFrame, latestFrameRef } from '../services/frames.js'
import type {
  AssessFrame,
  Bus,
  LoopDeps,
  ObservationWriter,
  SessionReader,
  SpeechProvider,
  Transport,
  VisionProvider,
} from './types.js'
import { createLoop, type Loop, type LoopConfig, DEFAULT_LOOP_CONFIG } from './index.js'

/**
 * The Prisma binding for the loop's two seams. The loop itself never imports
 * Prisma: this file is the only place that knows how a window is read and how
 * an observation is written, which is what keeps `observe/index.ts` testable
 * without a database.
 */

type PrismaLike = typeof defaultPrisma

function asJson(value: unknown): unknown {
  return value ?? null
}

/** A frame's bytes may not be in memory; the media layer can supply them. */
export type FrameBytesReader = (ref: ObjectRef | string) => Promise<Buffer | null>

export function createPrismaReader(
  prisma: PrismaLike = defaultPrisma,
  frameBytes?: FrameBytesReader,
): SessionReader {
  async function goalFor(sessionId: string): Promise<GoalContract | null> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { goal: true },
    })
    if (!session?.goal) return null
    const row = session.goal
    const parsed = Goal.safeParse({
      id: row.id,
      kind: row.kind,
      objective: row.objective,
      successCriteria: row.successCriteria,
      timeBudgetMinutes: row.timeBudgetMinutes,
      breakPolicy: row.breakPolicy,
      allowedApps: asJson(row.allowedApps),
      blockedApps: asJson(row.blockedApps),
      allowedSites: asJson(row.allowedSites),
      blockedSites: asJson(row.blockedSites),
      permissions: asJson(row.permissions),
      automations: asJson(row.automations),
      policy: { ...DEFAULT_POLICY, ...(asJson(row.policy) as object | null) },
      active: row.active,
      createdAt: row.createdAt.toISOString(),
    })
    return parsed.success ? parsed.data : null
  }

  return {
    async window(sessionId: string): Promise<SignalWindow | null> {
      // The folded window is computed by the signal service as signals arrive,
      // so the loop reads it rather than recomputing it and disagreeing.
      return getWindow(sessionId)
    },

    async frames(sessionId: string): Promise<AssessFrame[]> {
      // The newest frame the rig uploaded wins. The signal window's `lastFrameRef`
      // is only a hint; the frame store is the truth, and it survives a stream
      // stopping so the last page can still be assessed.
      const ref = latestFrameRef(sessionId)
      if (ref === null) return []
      const bytes = frameBytes ? await frameBytes(ref) : await getFrame(ref)
      return [
        {
          kind: 'desk',
          ref: typeof ref === 'string' ? ref : (ref.key ?? String(ref)),
          mediaType: 'image/jpeg',
          bytes: bytes ? Buffer.from(bytes) : null,
          width: null,
          height: null,
        },
      ]
    },

    goalFor,

    async policyFor(sessionId: string): Promise<Policy> {
      const goal = await goalFor(sessionId)
      return goal?.policy ?? DEFAULT_POLICY
    },
  }
}

export function createPrismaWriter(prisma: PrismaLike = defaultPrisma): ObservationWriter {
  return {
    async write(input): Promise<Observation> {
      const action = (input.action ?? null) as Intervention | null
      const row = await prisma.observation.create({
        data: {
          sessionId: input.sessionId,
          signals: input.window,
          assessment: (input.assessment ?? null) as never,
          tier: input.tier,
          action: (action ?? null) as never,
          outcome: input.outcome,
          confidence: input.confidence,
          reason: input.reason,
          latencyMs: input.latencyMs,
        },
      })

      if (action && input.tier >= 2) {
        await prisma.intervention.create({
          data: {
            sessionId: input.sessionId,
            observationId: row.id,
            tier: action.tier,
            channel: action.channel,
            message: action.message,
            action: (action.action ?? null) as never,
            reversible: action.reversible,
            reason: action.reason,
          },
        })
      }

      return Observation.parse({
        id: row.id,
        sessionId: row.sessionId,
        ts: row.ts.toISOString(),
        signals: input.window,
        assessment: input.assessment,
        tier: row.tier,
        action,
        outcome: (row.outcome as Outcome | null) ?? null,
        confidence: row.confidence,
        reason: row.reason,
        latencyMs: row.latencyMs,
      })
    },

    async markOutcome(observationId: string, outcome: Outcome): Promise<void> {
      await prisma.observation.update({
        where: { id: observationId },
        data: { outcome },
      })
      // The intervention that came from this observation carries the same verdict.
      await prisma.intervention.updateMany({
        where: { observationId },
        data: {
          outcome,
          resolvedAt: outcome === 'resolved' || outcome === 'reverted' ? new Date() : null,
        },
      })
    },

    async recentOutcomes(sessionId: string, limit: number) {
      const rows = await prisma.observation.findMany({
        where: { sessionId, tier: { gt: 0 } },
        orderBy: { ts: 'desc' },
        take: limit,
      })
      return rows.map((row) => {
        const assessment = Assessment.safeParse(row.assessment)
        return {
          tier: row.tier,
          kind: assessment.success ? assessment.data.kind : null,
          outcome: row.outcome ?? 'unknown',
        }
      })
    },

    async lastSpokenAt(sessionId: string): Promise<number | null> {
      const row = await prisma.observation.findFirst({
        where: { sessionId, tier: 3 },
        orderBy: { ts: 'desc' },
      })
      return row ? row.ts.getTime() : null
    },

    async lastNudgeAt(sessionId: string): Promise<number | null> {
      const row = await prisma.observation.findFirst({
        where: { sessionId, tier: 2 },
        orderBy: { ts: 'desc' },
      })
      return row ? row.ts.getTime() : null
    },

    async consecutiveOffGoal(sessionId: string): Promise<number> {
      const rows = await prisma.observation.findMany({
        where: { sessionId },
        orderBy: { ts: 'desc' },
        take: 50,
      })
      let count = 0
      for (const row of rows) {
        const assessment = Assessment.safeParse(row.assessment)
        if (assessment.success && assessment.data.onTask === false) count += 1
        else break
      }
      return count
    },
  }
}

export interface PrismaLoopInput {
  prisma?: PrismaLike
  bus: Bus
  transport: Transport
  vision: VisionProvider
  speech: SpeechProvider
  logger: LoopDeps['logger']
  automate?: LoopDeps['automate']
  frameBytes?: FrameBytesReader
  config?: LoopConfig
}

/** The loop, wired to the database. This is what the server starts. */
export function createPrismaLoop(input: PrismaLoopInput): Loop {
  const prisma = input.prisma ?? defaultPrisma
  return createLoop(
    {
      // The loop uses its own monotonic-ish wall clock; Date is enough here.
      clock: { now: () => Date.now() },
      bus: input.bus,
      transport: input.transport,
      vision: input.vision,
      speech: input.speech,
      reader: createPrismaReader(prisma, input.frameBytes),
      writer: createPrismaWriter(prisma),
      automate: input.automate,
      logger: input.logger,
    },
    input.config ?? DEFAULT_LOOP_CONFIG,
  )
}
