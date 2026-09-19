/**
 * Every read the web makes. Server-side only: pages are server components that call these.
 *
 * With `HELI_API_URL` set and the server answering, data is live and parsed through
 * `@heli/contracts`. Otherwise — no server yet, or it is down on stage — the same shapes come from
 * `@heli/fixtures`, and the shell says so. The page never has to know which.
 */
import { cache } from 'react'
import type { z } from 'zod'
import {
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTiersResponse,
  DevLoginResponse,
  DeviceListResponse,
  GoalListResponse,
  SessionDetailResponse,
  SessionListResponse,
} from '@heli/contracts'
import { fixtures, PAIRING_CODE } from '@heli/fixtures'

const BASE = process.env.HELI_API_URL?.replace(/\/$/, '') ?? null
const TIMEOUT_MS = 2500

export type DataSource = 'live' | 'demo'

const demo = cache(() => fixtures())

const connect = cache(async (): Promise<{ source: DataSource; token: string | null }> => {
  if (!BASE) return { source: 'demo', token: null }
  try {
    const res = await fetch(`${BASE}/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`dev-login ${res.status}`)
    const { token } = DevLoginResponse.parse(await res.json())
    return { source: 'live', token }
  } catch (error) {
    console.warn(`[heli] ${BASE} unreachable, serving demo data:`, String(error))
    return { source: 'demo', token: null }
  }
})

async function read<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  fallback: () => z.infer<S>,
): Promise<z.infer<S>> {
  const { source, token } = await connect()
  if (source === 'demo') return fallback()
  try {
    const res = await fetch(`${BASE}/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 404) return fallback()
    if (!res.ok) throw new Error(`${path} ${res.status}`)
    return schema.parse(await res.json())
  } catch (error) {
    console.warn(`[heli] ${path} failed, serving demo data:`, String(error))
    return fallback()
  }
}

export async function dataSource(): Promise<DataSource> {
  return (await connect()).source
}

export const api = {
  goals: () => read('/goals', GoalListResponse, () => [demo().world.goal]),
  devices: () => read('/devices', DeviceListResponse, () => [demo().world.device]),
  sessions: () => read('/sessions', SessionListResponse, () => demo().sessions()),
  session: (id: string) =>
    read(`/sessions/${encodeURIComponent(id)}`, SessionDetailResponse.nullable(), () =>
      demo().session(id),
    ),
  analytics: {
    summary: () => read('/analytics/summary', AnalyticsSummary, () => demo().analytics.summary()),
    tiers: () => read('/analytics/tiers', AnalyticsTiersResponse, () => demo().analytics.tiers()),
    apps: () => read('/analytics/apps', AnalyticsAppsResponse, () => demo().analytics.apps()),
    heatmap: () =>
      read('/analytics/heatmap', AnalyticsHeatmapResponse, () => demo().analytics.heatmap()),
  },
  /** The pairing code is not readable over REST yet; the seed's is the demo's. */
  pairingCode: async () => PAIRING_CODE,
}
