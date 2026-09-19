import { randomUUID } from 'node:crypto'

import type { Intervention, SpeechSynthesisResult } from '@heli/contracts'

import type { SpeechProvider, Transport } from '../observe/types.js'

/**
 * The exit of the loop. A fired intervention becomes a spoken line or a nudge,
 * and the delivery is recorded. The model's prose lives in `message`, which the
 * policy wrote; `reason` and the assessment's `because` are never spoken.
 */

export interface DeliveryRecord {
  sessionId: string
  momentId: string | null
  tier: number
  channel: string
  text: string | null
  delivered: boolean
  acknowledged: boolean
  durationMs: number
  at: number
}

export interface DeliverInterventionDeps {
  intervention: Intervention
  sessionId: string
  /** The goal's language, e.g. 'en'. Passed through to the provider. */
  language: string
  speech: SpeechProvider
  transport: Transport
  /** Where the record lands. Implemented over Prisma in P1. */
  recordDelivery?: (record: DeliveryRecord) => Promise<void> | void
  clock?: { now(): number }
  logger?: {
    info(obj: unknown, msg?: string): void
    warn(obj: unknown, msg?: string): void
    error(obj: unknown, msg?: string): void
  }
}

export interface DeliveryResult {
  delivered: boolean
  acknowledged: boolean
  durationMs: number
}

const SILENT: DeliveryResult = { delivered: false, acknowledged: false, durationMs: 0 }

/**
 * Tier 2 is a nudge (a notification, no audio). Tier 3 is a spoken line. Tiers
 * 0/1 are not delivered here and tiers 4/5 (automation, summary) must never be
 * spoken through this path. Synthesis failure is reported as not delivered — it
 * is never pretended that the tutor spoke.
 */
export async function deliverIntervention(
  deps: DeliverInterventionDeps,
): Promise<DeliveryResult> {
  const { intervention, sessionId, language, speech, transport, recordDelivery, clock, logger } =
    deps
  const at = () => clock?.now() ?? Date.now()
  const text = intervention.message

  if (intervention.tier !== 2 && intervention.tier !== 3) {
    logger?.info(
      { sessionId, tier: intervention.tier },
      'speech: tier is not delivered on the speech path',
    )
    return SILENT
  }

  if (!text) {
    logger?.warn({ sessionId, tier: intervention.tier }, 'speech: intervention has no message')
    return SILENT
  }

  if (intervention.tier === 2) {
    try {
      const shown = await transport.nudge({ sessionId, message: text })
      await recordDelivery?.({
        sessionId,
        momentId: null,
        tier: intervention.tier,
        channel: intervention.channel,
        text,
        delivered: shown,
        acknowledged: shown,
        durationMs: 0,
        at: at(),
      })
      return { delivered: shown, acknowledged: shown, durationMs: 0 }
    } catch (error) {
      logger?.error({ error, sessionId }, 'speech: nudge delivery failed')
      await recordDelivery?.({
        sessionId,
        momentId: null,
        tier: intervention.tier,
        channel: intervention.channel,
        text,
        delivered: false,
        acknowledged: false,
        durationMs: 0,
        at: at(),
      })
      return SILENT
    }
  }

  const momentId = randomUUID()
  let audio: SpeechSynthesisResult
  try {
    audio = await speech.synthesize({ text, voice: null, language })
  } catch (error) {
    logger?.error({ error, sessionId }, 'speech: synthesis failed, nothing was spoken')
    await recordDelivery?.({
      sessionId,
      momentId,
      tier: intervention.tier,
      channel: intervention.channel,
      text,
      delivered: false,
      acknowledged: false,
      durationMs: 0,
      at: at(),
    })
    return SILENT
  }

  try {
    const { delivered, acknowledged } = await transport.deliverLine({
      sessionId,
      text,
      hintLevel: intervention.tier,
      audio,
      momentId,
    })
    await recordDelivery?.({
      sessionId,
      momentId,
      tier: intervention.tier,
      channel: intervention.channel,
      text,
      delivered,
      acknowledged,
      durationMs: audio.durationMs,
      at: at(),
    })
    return { delivered, acknowledged, durationMs: audio.durationMs }
  } catch (error) {
    logger?.error({ error, sessionId }, 'speech: delivery failed')
    await recordDelivery?.({
      sessionId,
      momentId,
      tier: intervention.tier,
      channel: intervention.channel,
      text,
      delivered: false,
      acknowledged: false,
      durationMs: audio.durationMs,
      at: at(),
    })
    return { delivered: false, acknowledged: false, durationMs: audio.durationMs }
  }
}
