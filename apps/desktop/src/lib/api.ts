/**
 * The desktop's one door to the server. Everything crossing it is parsed by `@heli/contracts`.
 *
 * `VITE_HELI_API` points at the server (default `http://localhost:3001`). There is no fake data:
 * when the server cannot be reached a read comes back empty, `connection` says `offline`, and the
 * chrome says so. A write that fails throws.
 */
import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import {
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTiersResponse,
  DevLoginResponse,
  GoalListResponse,
  GoalResponse,
  LiveEvent,
  SessionDetailResponse,
  SessionListResponse,
  SignalWindowResponse,
  GoalDraft,
  OpenSessionResponse,
  DeskActionRecord,
  DeskRegisterResponse,
  MobilePairCodeResponse,
  PhoneListResponse,
  type DeskActionRequest,
  type DeskRegistration,
  type OpenSessionRequest,
  type SignalBatch,
  type GoalCreateRequest,
  type GoalUpdateRequest,
} from '@heli/contracts'
import { logger } from './log'

const log = logger('api')
const BASE = ((import.meta.env.VITE_HELI_API as string | undefined) ?? 'http://localhost:3001').replace(/\/$/, '')
const TIMEOUT_MS = 2500

export type Connection = 'online' | 'offline'

/* ---- connection, observable -------------------------------------------- */

let source: Connection = 'online'
const listeners = new Set<() => void>()
function setSource(next: Connection) {
  if (next === source) return
  source = next
  listeners.forEach((l) => l())
}
export function useConnection(): Connection {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => source,
  )
}

/* ---- transport --------------------------------------------------------- */

let token: Promise<string | null> | null = null
function auth(): Promise<string | null> {
  token ??= (async () => {
    try {
      const res = await fetch(`${BASE}/v1/auth/dev-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`dev-login ${res.status}`)
      return DevLoginResponse.parse(await res.json()).token
    } catch (error) {
      log.warn(`${BASE} unreachable`, String(error))
      token = null // retry on the next call
      setSource('offline')
      return null
    }
  })()
  return token
}

/** The server's base URL, for checks that are not API calls (preflight). */
export const serverBase = () => BASE

/** The bearer and the socket base, for `lib/socket`. Null when there is no server. */
export async function socketTarget(): Promise<{ url: string; token: string } | null> {
  const bearer = await auth()
  if (!bearer) return null
  return { url: `${BASE.replace(/^http/, 'ws')}/ws/desktop`, token: bearer }
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function call<S extends z.ZodTypeAny>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: S,
  /** What a read answers with when it cannot be read: always empty, never invented. */
  empty: () => z.infer<S>,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<z.infer<S>> {
  const bearer = await auth()
  if (!bearer) {
    if (method !== 'GET') throw new Error(`The server at ${BASE} is not reachable.`)
    return empty()
  }
  try {
    const res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new HttpError(`${method} ${path} ${res.status}`, res.status)
    setSource('online')
    return schema.parse(await res.json())
  } catch (error) {
    // A write that did not land throws: "Saved" has to be true.
    if (method !== 'GET') {
      log.error(`${method} ${path} failed`, String(error))
      throw error instanceof Error ? error : new Error(String(error))
    }
    // A route that errors (a 500, a 404) is that route's problem; an unreachable server is everyone's.
    if (error instanceof HttpError) log.warn(`${method} ${path} answered ${error.status}`)
    else {
      log.warn(`${method} ${path} failed`, String(error))
      setSource('offline')
    }
    return empty()
  }
}

/* ---- the reads and the few writes the desktop owns ----------------------- */

const EMPTY_SUMMARY: z.infer<typeof AnalyticsSummary> = {
  focusedMinutes: 0,
  offTaskMinutes: 0,
  interventions: 0,
  longestFocusRunSeconds: 0,
  tierHistogram: {},
}

export const api = {
  goals: () => call('GET', '/goals', GoalListResponse, () => []),
  createGoal: (goal: GoalCreateRequest) => call('POST', '/goals', GoalResponse, () => null as never, goal),
  updateGoal: (id: string, patch: GoalUpdateRequest) =>
    call('PUT', `/goals/${id}`, GoalResponse, () => null as never, patch),
  sessions: () => call('GET', '/sessions', SessionListResponse, () => []),
  session: (id: string) => call('GET', `/sessions/${id}`, SessionDetailResponse.nullable(), () => null),
  window: (sessionId: string) =>
    call('GET', `/sessions/${sessionId}/window`, SignalWindowResponse.nullable(), () => null),
  /** Unparsed on purpose: `lib/desk` checks it against the contract and tolerates older servers. */
  desk: () => call('GET', '/desk', z.unknown().nullable(), () => null),
  /** A sentence in, a goal draft out. The model takes seconds; the screen says it is reading. */
  draftGoal: (sentence: string) =>
    call('POST', '/goals/draft', GoalDraft.nullable(), () => null, { sentence }, 20_000),
  closeSession: (id: string) =>
    call('POST', `/sessions/${encodeURIComponent(id)}/close`, z.unknown(), () => null, {}),
  openSession: (body: OpenSessionRequest) =>
    call('POST', '/sessions', OpenSessionResponse.nullable(), () => null, body),
  renameDesk: (body: DeskRegistration) =>
    call('POST', '/desks', DeskRegisterResponse.nullable(), () => null, body),
  deskAction: (deskId: string, body: DeskActionRequest) =>
    call('POST', `/desks/${encodeURIComponent(deskId)}/actions`, DeskActionRecord.nullable(), () => null, body),
  /** A fresh six-digit code for a phone. Single-use, five minutes, in server memory only. */
  pairCode: () => call('POST', '/mobile/pair/code', MobilePairCodeResponse.nullable(), () => null),
  /** The paired phones, newest first. Empty when none, never invented. */
  phones: () => call('GET', '/mobile/phones', PhoneListResponse, () => []),
  analytics: {
    summary: () => call('GET', '/analytics/summary', AnalyticsSummary, () => EMPTY_SUMMARY),
    tiers: () => call('GET', '/analytics/tiers', AnalyticsTiersResponse, () => []),
    apps: () => call('GET', '/analytics/apps', AnalyticsAppsResponse, () => []),
    heatmap: () => call('GET', '/analytics/heatmap', AnalyticsHeatmapResponse, () => []),
  },
}

/**
 * The newest frame of one source as an object URL, or null. `img` cannot send a bearer, so the
 * bytes are fetched and handed over as a blob; the caller revokes the previous URL.
 */
export async function frameUrl(
  sessionId: string,
  source: 'camera' | 'screen',
): Promise<string | null> {
  const bearer = await auth()
  if (!bearer) return null
  try {
    const res = await fetch(
      `${BASE}/v1/sessions/${encodeURIComponent(sessionId)}/frame.jpg?source=${source}`,
      {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // The route answers `max-age=5`; the pane polls faster than that and wants every frame.
        cache: 'no-store',
      },
    )
    // 204 is "no frame yet": an empty body is not an image.
    if (!res.ok || res.status === 204) return null
    const blob = await res.blob()
    return blob.size ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}

/** Desktop signals to the server. Returns false when there is no server to take them. */
export async function postSignals(batch: SignalBatch): Promise<boolean> {
  const bearer = await auth()
  if (!bearer) return false
  try {
    const res = await fetch(`${BASE}/v1/signals`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch (error) {
    log.debug('signal batch not delivered', String(error))
    return false
  }
}

/**
 * One screen frame, raw JPEG, through the same intake the rig uses (docs/03-desk-capture.md). The
 * server attributes it to the open session; `x-heli-source: screen` says it is the screen, not the
 * desk camera.
 */
export async function postScreenFrame(jpeg: ArrayBuffer, capturedAt: string): Promise<boolean> {
  const bearer = await auth()
  if (!bearer) return false
  try {
    const res = await fetch(`${BASE}/v1/desk/frames`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'image/jpeg',
        'x-heli-source': 'screen',
        'x-heli-captured-at': capturedAt,
      },
      body: jpeg,
      signal: AbortSignal.timeout(10_000),
    })
    // 409 means nothing is being watched: nowhere to put it, and not an error.
    return res.ok || res.status === 409
  } catch {
    return false
  }
}

/**
 * Subscribe to a session's live channel. Returns an unsubscribe. With no server, the caller gets
 * `null` and runs the fixture feed instead — the event shapes are identical.
 */
export async function subscribe(
  sessionId: string,
  onEvent: (event: LiveEvent) => void,
): Promise<(() => void) | null> {
  const bearer = await auth()
  if (!bearer) return null
  const url = `${BASE}/v1/live/${sessionId}?token=${encodeURIComponent(bearer)}`
  const es = new EventSource(url)
  const names = ['observation', 'intervention', 'signal.window', 'state'] as const
  for (const name of names) {
    es.addEventListener(name, (msg) => {
      const parsed = LiveEvent.safeParse({
        event: name,
        data: JSON.parse((msg as MessageEvent).data),
      })
      if (parsed.success) onEvent(parsed.data)
      else log.warn(`dropped a malformed ${name} event`, parsed.error.issues)
    })
  }
  es.onerror = () => log.debug('live channel reconnecting')
  return () => es.close()
}
