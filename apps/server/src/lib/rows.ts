import type { ZodTypeAny, z } from 'zod'

import { Assessment, Intervention, Outcome, SignalWindow, Tier } from '@heli/contracts'
import type { Intervention as ApiIntervention, Observation as ApiObservation } from '@heli/contracts'
import type { Intervention as InterventionRow, Observation as ObservationRow } from '@prisma/client'

import { childLogger } from '../logger.js'

const log = childLogger({ module: 'rows' })

/**
 * Prisma row to contract shape, for the two models the product is actually made
 * of. Named for the rows rather than for `Observation`, because it maps
 * interventions too and an intervention is not a sub-shape of anything.
 *
 * Those rows are older and looser than the contracts: `signals`, `assessment`
 * and `action` are untyped `Json` columns, `tier` and `outcome` are a plain
 * `Int` and `String?`, and the contract's `Intervention` does not even carry the
 * id and timestamps the table stores.
 *
 * Both `GET /v1/sessions/:id` (013) and the SSE channel's replay (016) have to
 * turn these rows into contract shapes, and the SSE channel lands first, so this
 * is a shared file with its own row rather than a private helper in whichever of
 * the two happened to be written first. Two copies of this mapping would drift,
 * and the one that drifted would be the one feeding the dashboard.
 */

/**
 * Parses one `Json` column, or reports it. A field that is not in contract shape
 * becomes `null` rather than a guess: every field this is used on is nullable in
 * its contract, so `null` is a value the client already understands, and it
 * means "nothing usable here" rather than a fabricated window or assessment.
 */
function optionalField<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  options: { rowId: string; field: string },
): z.infer<S> | null {
  if (value === null || value === undefined) return null

  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data

  log.warn(
    { rowId: options.rowId, field: options.field, issues: parsed.error.issues },
    'a column is not in contract shape; sending null for it',
  )
  return null
}

/**
 * A row becomes an `Observation`, or `null` if it cannot be one.
 *
 * The distinction matters. Losing `assessment` or `outcome` degrades an
 * observation — the signal window it was judged on is still real work data, so
 * the observation is kept with that field nulled. Losing `signals` or `tier`
 * does not: those are what the observation *is*, and inventing a zeroed window
 * would feed a fabricated "focused for 0 seconds" into every analytics query
 * downstream. So a row like that is dropped and logged, never faked.
 */
export function toApiObservation(row: ObservationRow): ApiObservation | null {
  const signals = SignalWindow.safeParse(row.signals)
  if (!signals.success) {
    log.error(
      { observationId: row.id, sessionId: row.sessionId, issues: signals.error.issues },
      'observation has no readable signal window; dropping the row',
    )
    return null
  }

  const tier = Tier.safeParse(row.tier)
  if (!tier.success) {
    log.error(
      { observationId: row.id, tier: row.tier },
      'observation tier is outside 0-5; dropping the row',
    )
    return null
  }

  const confidenceOk =
    row.confidence !== null && row.confidence >= 0 && row.confidence <= 1

  return {
    id: row.id,
    sessionId: row.sessionId,
    ts: row.ts.toISOString(),
    signals: signals.data,
    assessment: optionalField(Assessment, row.assessment, {
      rowId: row.id,
      field: 'assessment',
    }),
    tier: tier.data,
    action: optionalField(Intervention, row.action, { rowId: row.id, field: 'action' }),
    outcome: optionalField(Outcome, row.outcome, { rowId: row.id, field: 'outcome' }),
    // A confidence outside 0-1 would fail the response serializer and turn a
    // whole session view into a 500, so it is dropped here instead.
    confidence: confidenceOk ? row.confidence : null,
    reason: row.reason,
    latencyMs:
      row.latencyMs !== null && Number.isInteger(row.latencyMs) && row.latencyMs >= 0
        ? row.latencyMs
        : null,
  }
}

/** `toApiObservation` over a list, in order, skipping the rows it drops. */
export function toApiObservations(rows: ObservationRow[]): ApiObservation[] {
  const mapped: ApiObservation[] = []
  for (const row of rows) {
    const observation = toApiObservation(row)
    if (observation) mapped.push(observation)
  }
  return mapped
}

/**
 * A row becomes an `Intervention`. The contract's shape is deliberately smaller
 * than the table's — it is what the device, the desktop and the web are allowed
 * to see, so `id`, `outcome`, `firedAt` and `resolvedAt` stay server-side.
 */
export function toApiIntervention(row: InterventionRow): ApiIntervention | null {
  const tier = Tier.safeParse(row.tier)
  if (!tier.success) {
    log.error({ interventionId: row.id, tier: row.tier }, 'intervention tier is outside 0-5')
    return null
  }

  const channel = optionalChannel(row.channel)
  if (channel === null) return null

  const action = optionalField(Intervention.shape.action, row.action, {
    rowId: row.id,
    field: 'action',
  })

  return {
    tier: tier.data,
    channel,
    // The contract caps a spoken or notified line at 220 characters; the column
    // does not. Truncating would put words in the system's mouth, so an
    // over-long message is dropped to null and logged.
    message: boundedMessage(row),
    action,
    reversible: row.reversible,
    reason: row.reason ?? '',
  }
}

const CHANNELS = Intervention.shape.channel.options

function optionalChannel(value: string): ApiIntervention['channel'] | null {
  const parsed = Intervention.shape.channel.safeParse(value)
  if (parsed.success) return parsed.data
  log.error({ channel: value, allowed: CHANNELS }, 'intervention channel is not one of the six')
  return null
}

// `Intervention.message` is capped at 220 characters and the column is not.
// Held here so the check and the log line cannot disagree.
const MAX_MESSAGE_CHARS = 220

function boundedMessage(row: InterventionRow): string | null {
  if (row.message === null) return null
  if (row.message.length <= MAX_MESSAGE_CHARS) return row.message
  log.warn(
    { interventionId: row.id, length: row.message.length },
    `intervention message is over ${MAX_MESSAGE_CHARS} characters; sending null`,
  )
  return null
}

/** `toApiIntervention` over a list, skipping the rows it drops. */
export function toApiInterventions(rows: InterventionRow[]): ApiIntervention[] {
  const mapped: ApiIntervention[] = []
  for (const row of rows) {
    const intervention = toApiIntervention(row)
    if (intervention) mapped.push(intervention)
  }
  return mapped
}
