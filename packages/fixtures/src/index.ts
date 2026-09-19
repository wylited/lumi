/**
 * @heli/fixtures — every read the desktop and the web make, as contract-shaped data.
 *
 * The apps read through their own `api` module; when no server is configured, or it is down,
 * that module answers from here. Same shapes, same story as `apps/server/prisma/seed.ts`.
 */
import type {
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTiersResponse,
  Session,
  SessionDetail,
} from '@heli/contracts'
import { SessionListResponse } from '@heli/contracts'
import * as analytics from './analytics.js'
import { type World, buildWorld } from './world.js'

export { buildWorld, PAIRING_CODE, type World } from './world.js'
export { createLiveFeed, type LiveFeed, type LiveFeedOptions, type LiveScenario } from './live.js'
export { USER, DEVICE_ID, GOAL_ID, SEED_SESSION_ID } from './build.js'

export interface Fixtures {
  world: World
  sessions: () => Session[]
  session: (id: string) => SessionDetail | null
  analytics: {
    summary: () => AnalyticsSummary
    tiers: () => AnalyticsTiersResponse
    apps: () => AnalyticsAppsResponse
    heatmap: () => AnalyticsHeatmapResponse
  }
}

export function fixtures(now?: Date): Fixtures {
  const world = buildWorld(now)
  return {
    world,
    // Parsing strips the detail-only keys, exactly as the list endpoint would.
    sessions: () => SessionListResponse.parse(world.sessions),
    session: (id) => world.sessions.find((s) => s.id === id) ?? null,
    analytics: {
      summary: () => analytics.summary(world.sessions),
      tiers: () => analytics.tiers(world.sessions),
      apps: () => analytics.apps(world.sessions),
      heatmap: () => analytics.heatmap(world.sessions),
    },
  }
}
