import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import {
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTiersResponse,
} from '@heli/contracts'
import type {
  AnalyticsAppsResponse as AppsResponse,
  AnalyticsHeatmapResponse as HeatmapResponse,
  AnalyticsSummary as SummaryResponse,
  AnalyticsTiersResponse as TiersResponse,
} from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import {
  analyticsApps,
  analyticsHeatmap,
  analyticsSummary,
  analyticsTiers,
} from '../services/analytics.js'

/**
 * The four reads the dashboard is made of.
 *
 * All four are `GET`, JSON, and behind `requireUser`: the web's `read()` and the
 * desktop's `call()` both send `Authorization: Bearer …`, and neither sends a
 * user id, because the deployment has exactly one.
 *
 * Every response declares its `@heli/contracts` schema. The serializer validates
 * on the way out, so a shape that drifts from the contract is a loud 500 here
 * rather than a quiet fallback to demo data in two clients that treat any non-2xx
 * as "no server".
 */

/**
 * `from` and `to` are **optional**.
 *
 * Neither client sends a query string at all, and both parse the body through
 * `@heli/contracts` and fall back to fixtures on any error — so requiring a
 * window would not fail loudly anywhere, it would just make the dashboard show
 * invented numbers forever. Absent means *all time*, which is what makes the
 * seeded session appear on first load.
 *
 * When they are given they are inclusive bounds on the observation's `ts` (and
 * on an intervention's `firedAt`), and they are optional individually: `?from=`
 * alone is "since", `?to=` alone is "until".
 *
 * `z.coerce.date` rather than `z.string()` because a query string arrives as
 * text and every caller means an instant; a value that is not a date is a 400
 * with the offending path, which is the one case where a client bug should be
 * visible instead of silently widened into "all time".
 */
const AnalyticsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

const analytics: FastifyPluginAsync = async (app) => {
  /**
   * `focusedMinutes`, `offTaskMinutes`, `interventions`, `longestFocusRunSeconds`
   * and the tier histogram, over every session in the window.
   */
  app.get(
    '/v1/analytics/summary',
    {
      preHandler: requireUser,
      schema: { querystring: AnalyticsQuery, response: { 200: AnalyticsSummary } },
    },
    async (request): Promise<SummaryResponse> => analyticsSummary(request.query),
  )

  /** `{ tier, outcome, count }[]`: `GROUP BY tier, outcome` over interventions. */
  app.get(
    '/v1/analytics/tiers',
    {
      preHandler: requireUser,
      schema: { querystring: AnalyticsQuery, response: { 200: AnalyticsTiersResponse } },
    },
    async (request): Promise<TiersResponse> => analyticsTiers(request.query),
  )

  /** `{ app, seconds, onTask }[]`, ranked by seconds descending. */
  app.get(
    '/v1/analytics/apps',
    {
      preHandler: requireUser,
      schema: { querystring: AnalyticsQuery, response: { 200: AnalyticsAppsResponse } },
    },
    async (request): Promise<AppsResponse> => analyticsApps(request.query),
  )

  /** `{ hour, onTaskRatio }[]`, hour 0-23, ratio 0-1. See the service for the timezone. */
  app.get(
    '/v1/analytics/heatmap',
    {
      preHandler: requireUser,
      schema: { querystring: AnalyticsQuery, response: { 200: AnalyticsHeatmapResponse } },
    },
    async (request): Promise<HeatmapResponse> => analyticsHeatmap(request.query),
  )
}

export default analytics
