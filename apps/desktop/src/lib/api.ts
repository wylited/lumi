/**
 * The desktop's one door to the server. Everything crossing it is parsed by `@heli/contracts`.
 *
 * `VITE_HELI_API` points at the server. When it is unset or unreachable the same calls answer from
 * `@heli/fixtures`, and `source` says `demo` so the chrome can be honest about it.
 */
import { useSyncExternalStore } from 'react'
import type { z } from 'zod'
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
  type SignalBatch,
  type GoalCreateRequest,
  type GoalUpdateRequest,
} from '@heli/contracts'
import { fixtures } from '@heli/fixtures'
import { logger } from './log'

const log = logger('api')
const BASE = (import.meta.env.VITE_HELI_API as string | undefined)?.replace(/\/$/, '') ?? null
const TIMEOUT_MS = 2500

export type DataSource = 'live' | 'demo'

let demoData: ReturnType<typeof fixtures> | null = null
export function demo() {
  demoData ??= fixtures()
  return demoData
}

/* ---- source, observable ------------------------------------------------ */

let source: DataSource = BASE ? 'live' : 'demo'
const listeners = new Set<() => void>()
function setSource(next: DataSource) {
  if (next === source) return
  source = next
  listeners.forEach((l) => l())
}
export function useDataSource(): DataSource {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => source,
  )
}

/* ---- transport --------------------------------------------------------- */

let token: Promise<string | null> | null = null
function auth(): Promise<string | null> {
  token ??= (async () => {
    if (!BASE) return null
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
      log.warn(`${BASE} unreachable, using demo data`, String(error))
      token = null // retry on the next call
      setSource('demo')
      return null
    }
  })()
  return token
}

async function call<S extends z.ZodTypeAny>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  schema: S,
  fallback: () => z.infer<S>,
  body?: unknown,
): Promise<z.infer<S>> {
  const bearer = await auth()
  if (!bearer) return fallback()
  try {
    const res = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
    setSource('live')
    return schema.parse(await res.json())
  } catch (error) {
    log.warn(`${method} ${path} failed, using demo data`, String(error))
    setSource('demo')
    return fallback()
  }
}

/* ---- the reads and the few writes the desktop owns ----------------------- */

export const api = {
  goals: () => call('GET', '/goals', GoalListResponse, () => [demo().world.goal]),
  createGoal: (goal: GoalCreateRequest) =>
    call('POST', '/goals', GoalResponse, () => demoSave(goal), goal),
  updateGoal: (id: string, patch: GoalUpdateRequest) =>
    call(
      'PUT',
      `/goals/${id}`,
      GoalResponse,
      () => demoSave({ ...demo().world.goal, ...patch }),
      patch,
    ),
  sessions: () => call('GET', '/sessions', SessionListResponse, () => demo().sessions()),
  session: (id: string) =>
    call('GET', `/sessions/${id}`, SessionDetailResponse.nullable(), () => demo().session(id)),
  window: (sessionId: string) =>
    call('GET', `/sessions/${sessionId}/window`, SignalWindowResponse.nullable(), () => null),
  analytics: {
    summary: () =>
      call('GET', '/analytics/summary', AnalyticsSummary, () => demo().analytics.summary()),
    tiers: () =>
      call('GET', '/analytics/tiers', AnalyticsTiersResponse, () => demo().analytics.tiers()),
    apps: () =>
      call('GET', '/analytics/apps', AnalyticsAppsResponse, () => demo().analytics.apps()),
    heatmap: () =>
      call('GET', '/analytics/heatmap', AnalyticsHeatmapResponse, () => demo().analytics.heatmap()),
  },
}

/** In demo mode a saved goal lives in memory for the run, so edit → reload still round-trips. */
function demoSave(goal: GoalCreateRequest | z.infer<typeof GoalResponse>) {
  const current = demo().world.goal
  const next = GoalResponse.parse({
    ...current,
    ...goal,
    id: current.id,
    createdAt: current.createdAt,
  })
  demo().world.goal = next
  return next
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

/** One screen frame, raw JPEG, tagged with the ref its `screen.frame` signal carried. */
export async function postScreenFrame(
  sessionId: string,
  ref: string,
  jpeg: ArrayBuffer,
): Promise<boolean> {
  const bearer = await auth()
  if (!bearer) return false
  try {
    const res = await fetch(
      `${BASE}/v1/signals/screen?sessionId=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(ref)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/jpeg' },
        body: jpeg,
        signal: AbortSignal.timeout(10_000),
      },
    )
    return res.ok
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
