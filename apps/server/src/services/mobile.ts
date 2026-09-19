import { randomInt, randomUUID } from 'node:crypto'

import { PHONE_SIGNAL, PhoneMotion } from '@heli/contracts'
import type { MobileBlocklist, MobileSession, PhoneSnapshot, Signal } from '@heli/contracts'

import { childLogger } from '../logger.js'
import { prisma } from '../lib/prisma.js'

/**
 * The phone: pairing, its latest state, and the one routing question the loop
 * asks — "is the person away from the desk?"
 *
 * In memory on purpose. A phone is a live surface, like the desktop socket: its
 * presence is a fact about *now*, and a restart that forgets a walking phone is
 * more honest than a database row that says it is still walking. The pairing
 * token is the durable half (the phone stores it); the server can lose this map
 * and the phone re-hellos on the next connection.
 */

const log = childLogger({ module: 'services.mobile' })

/** A walk to the couch and back. */
const PAIR_CODE_TTL_MS = 5 * 60 * 1000

/** After two minutes of silence a phone is unknown, not still. */
const FRESH_MS = 2 * 60 * 1000

/* ---- pairing -------------------------------------------------------------- */

/**
 * One active code, replaced by the next request. Single user, single desk: a
 * second code would be two ways into the same house, and the person asking is
 * standing at the desktop that is showing the first one.
 */
let activeCode: { code: string; expiresAt: number } | null = null

export interface IssuedPairCode {
  code: string
  expiresAt: string
}

export function issuePairCode(now = Date.now()): IssuedPairCode {
  // `randomInt` rather than `Math.random`: this is a credential, short-lived or
  // not. Six digits, leading zeros kept.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = now + PAIR_CODE_TTL_MS
  activeCode = { code, expiresAt }
  log.info({ expiresAt: new Date(expiresAt).toISOString() }, 'mobile: pairing code issued')
  return { code, expiresAt: new Date(expiresAt).toISOString() }
}

export class PairCodeRejected extends Error {
  readonly statusCode = 401
}

/**
 * Exchanges a code for a phone identity. Single use: the code is consumed
 * whether or not the caller continues, so a shoulder-surfed code is worthless
 * after the person's own phone has redeemed it.
 */
export function redeemPairCode(
  code: string,
  info: { name: string; platform: 'android' | 'ios'; appVersion: string },
  now = Date.now(),
): string {
  const current = activeCode
  activeCode = null
  if (current === null || current.code !== code.trim() || current.expiresAt <= now) {
    log.warn({}, 'mobile: pairing code rejected')
    throw new PairCodeRejected('That pairing code is wrong or has expired. Ask the desktop for a new one.')
  }

  const phoneId = `phone_${randomUUID()}`
  const record: PhoneRecord = {
    phoneId,
    name: info.name,
    platform: info.platform,
    appVersion: info.appVersion,
    lastSeenAt: now,
    sessionId: null,
    app: null,
    appSeconds: 0,
    usage: new Map(),
    unlocks: 0,
    motion: 'unknown',
    screenOn: null,
  }
  phones.set(phoneId, record)
  log.info({ phoneId, name: info.name, platform: info.platform }, 'mobile: paired')
  return phoneId
}

/* ---- state ---------------------------------------------------------------- */

interface PhoneRecord {
  phoneId: string
  name: string
  platform: 'android' | 'ios'
  appVersion: string
  lastSeenAt: number
  /** The session the phone last reported signals for, when there was one. */
  sessionId: string | null
  app: string | null
  usage: Map<string, number>
  appSeconds: number
  unlocks: number
  motion: PhoneMotion
  screenOn: boolean | null
}

const phones = new Map<string, PhoneRecord>()

const readString = (payload: Signal['payload'], keys: string[]): string | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

const readNumber = (payload: Signal['payload'], keys: string[]): number | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

const readBoolean = (payload: Signal['payload'], keys: string[]): boolean | null => {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

/**
 * Folds a batch into the phone's state. Unknown kinds are ignored rather than
 * stored: this service exists to answer the routing question and to give the
 * console an honest line, not to become a second signal ring.
 */
export function applyPhoneSignals(
  phoneId: string,
  signals: Signal[],
  sessionId: string | null = null,
  now = Date.now(),
): void {
  let record = phones.get(phoneId)
  if (record === undefined) {
    // A paired phone whose record was forgotten by a restart: recreate the
    // shell rather than dropping what it sends. The token is the identity.
    record = {
      phoneId,
      name: 'Phone',
      platform: 'android',
      appVersion: 'unknown',
      lastSeenAt: now,
      sessionId,
      app: null,
      appSeconds: 0,
      usage: new Map(),
      unlocks: 0,
      motion: 'unknown',
      screenOn: null,
    }
    phones.set(phoneId, record)
  }

  if (sessionId !== null) record.sessionId = sessionId
  record.lastSeenAt = now

  for (const signal of signals) {
    const { payload } = signal

    switch (signal.kind) {
      case PHONE_SIGNAL.app: {
        const app = readString(payload, ['app', 'appName'])
        if (app !== null) record.app = app
        break
      }
      case PHONE_SIGNAL.usage: {
        const app = readString(payload, ['app', 'appName'])
        const seconds = readNumber(payload, ['seconds', 'durationSeconds'])
        if (app !== null && seconds !== null && seconds > 0) {
          record.usage.set(app, (record.usage.get(app) ?? 0) + seconds)
        }
        break
      }
      case PHONE_SIGNAL.unlock: {
        const count = readNumber(payload, ['count', 'unlocks'])
        if (count !== null && count > 0) record.unlocks += Math.floor(count)
        break
      }
      case PHONE_SIGNAL.motion: {
        const state = readString(payload, ['state', 'motion'])
        const parsed = PhoneMotion.safeParse(state)
        record.motion = parsed.success ? parsed.data : 'unknown'
        break
      }
      case PHONE_SIGNAL.state: {
        const screen = readString(payload, ['screen', 'screenState'])
        if (screen === 'on') record.screenOn = true
        else if (screen === 'off') record.screenOn = false
        else record.screenOn = readBoolean(payload, ['screenOn', 'on'])
        break
      }
      default:
        break
    }
  }
}

/** A phone that has just paired, in the console, before its first batch. */
export function notePhoneHello(
  phoneId: string,
  info: { name?: string; platform?: 'android' | 'ios'; appVersion?: string },
  now = Date.now(),
): void {
  const record = phones.get(phoneId)
  if (record === undefined) {
    phones.set(phoneId, {
      phoneId,
      name: info.name ?? 'Phone',
      platform: info.platform ?? 'android',
      appVersion: info.appVersion ?? 'unknown',
      lastSeenAt: now,
      sessionId: null,
      app: null,
      appSeconds: 0,
      usage: new Map(),
      unlocks: 0,
      motion: 'unknown',
      screenOn: null,
    })
    return
  }
  if (info.name !== undefined) record.name = info.name
  if (info.platform !== undefined) record.platform = info.platform
  if (info.appVersion !== undefined) record.appVersion = info.appVersion
  record.lastSeenAt = now
}

const AWAY_MOTION: readonly PhoneMotion[] = ['walking', 'running', 'driving']

const snapshotOf = (record: PhoneRecord, now: number): PhoneSnapshot => {
  const fresh = now - record.lastSeenAt <= FRESH_MS
  const app = record.app
  return {
    phoneId: record.phoneId,
    name: record.name,
    platform: record.platform,
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    app,
    appSeconds: app === null ? 0 : Math.round(record.usage.get(app) ?? 0),
    unlocks: record.unlocks,
    topApps: [...record.usage]
      .map(([name, seconds]) => ({ app: name, seconds: Math.round(seconds) }))
      .filter((a) => a.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8),
    motion: fresh ? record.motion : 'unknown',
    screenOn: fresh ? record.screenOn : null,
    // Unknown is not away: a stale phone must not move the tutor to a pocket
    // that may be in a different room. Away is only ever a positive statement.
    away: fresh && AWAY_MOTION.includes(record.motion),
  }
}

export function listPhones(now = Date.now()): PhoneSnapshot[] {
  return [...phones.values()]
    .map((record) => snapshotOf(record, now))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export function phoneSnapshot(phoneId: string, now = Date.now()): PhoneSnapshot | null {
  const record = phones.get(phoneId)
  return record === undefined ? null : snapshotOf(record, now)
}

/**
 * The routing question the loop's outbound half asks. True when a fresh phone
 * bound to this session says it is moving — the person took it with them.
 */
export function phoneAway(sessionId: string, now = Date.now()): boolean {
  for (const record of phones.values()) {
    if (record.sessionId !== sessionId) continue
    if (snapshotOf(record, now).away) return true
  }
  return false
}

/** The session's live phone, when one is bound to it. For the console. */
export function phoneForSession(sessionId: string, now = Date.now()): PhoneSnapshot | null {
  for (const record of phones.values()) {
    if (record.sessionId === sessionId) return snapshotOf(record, now)
  }
  return null
}

/** Drops everything. Tests and probes. */
export function resetPhones(): void {
  activeCode = null
  phones.clear()
}

/**
 * The one open session, resolved from the database. The phone never names a
 * session it has no business knowing: the server decides whose night it is,
 * exactly as it does for the rig's frames.
 */
export async function openSessionId(): Promise<string | null> {
  const row = await prisma.session.findFirst({
    where: { endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })
  return row?.id ?? null
}

/**
 * The phone's blocklist: the open session's goal's `blockedApps`, active only when that goal
 * allows changing things. Nothing open, or no permission, is an inactive empty list.
 */
export async function phoneBlocklist(): Promise<MobileBlocklist> {
  const row = await prisma.session.findFirst({
    where: { endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { id: true, goal: { select: { objective: true, blockedApps: true, permissions: true } } },
  })
  const goal = row?.goal ?? null
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const allowed = strings(goal?.permissions).includes('automate')
  const apps = strings(goal?.blockedApps).slice(0, 50)
  return {
    active: !!row && allowed && apps.length > 0,
    sessionId: row?.id ?? null,
    goal: goal?.objective ?? null,
    apps: allowed ? apps : [],
  }
}

/** The phone's one screen: the open session, its latest judgement, the blocklist, this phone. */
export async function phoneSession(phoneId: string): Promise<MobileSession> {
  const row = await prisma.session.findFirst({
    where: { endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      startedAt: true,
      goal: { select: { objective: true, timeBudgetMinutes: true } },
      observations: {
        orderBy: { ts: 'desc' },
        take: 240,
        select: { ts: true, assessment: true, tier: true },
      },
    },
  })
  const latest = row?.observations[0] ?? null
  const onTask = (latest?.assessment as { onTask?: unknown } | null)?.onTask
  return {
    session: row
      ? {
          id: row.id,
          startedAt: row.startedAt.toISOString(),
          goal: row.goal.objective,
          budgetMinutes: row.goal.timeBudgetMinutes ?? null,
        }
      : null,
    state: typeof onTask === 'boolean' ? (onTask ? 'focused' : 'off_goal') : 'waiting',
    judgedAt: latest ? latest.ts.toISOString() : null,
    timeline: [...(row?.observations ?? [])].reverse().map((o) => {
      const on = (o.assessment as { onTask?: unknown } | null)?.onTask
      return { on: typeof on === 'boolean' ? on : null, tier: Math.max(0, Math.min(5, o.tier)) }
    }),
    blocklist: await phoneBlocklist(),
    phone: phoneSnapshot(phoneId),
  }
}
