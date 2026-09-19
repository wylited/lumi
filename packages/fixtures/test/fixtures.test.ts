import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AnalyticsAppsResponse,
  AnalyticsHeatmapResponse,
  AnalyticsSummary,
  AnalyticsTiersResponse,
  Device,
  Goal,
  LiveEvent,
  SessionDetail,
  SessionListResponse,
} from '@heli/contracts'
import { createLiveFeed, fixtures } from '../src/index.js'

const f = fixtures(new Date('2026-09-19T18:00:00'))

test('every fixture parses through its contract', () => {
  Goal.parse(f.world.goal)
  Device.parse(f.world.device)
  SessionListResponse.parse(f.sessions())
  for (const s of f.world.sessions) SessionDetail.parse(s)
  AnalyticsSummary.parse(f.analytics.summary())
  AnalyticsTiersResponse.parse(f.analytics.tiers())
  AnalyticsAppsResponse.parse(f.analytics.apps())
  AnalyticsHeatmapResponse.parse(f.analytics.heatmap())
})

test('the seeded session tells the seed story', () => {
  const seed = f.session('sess_seed')
  assert.ok(seed)
  const loud = seed.observations.filter((o) => o.tier >= 2)
  assert.deepEqual(
    loud.map((o) => [o.tier, o.outcome]),
    [
      [2, 'ignored'],
      [3, 'resolved'],
    ],
  )
  assert.ok(seed.observations.filter((o) => o.tier === 0).length > 30, 'mostly silent')
})

test('the tier table names an intervention that worked', () => {
  const resolved = f.analytics.tiers().filter((r) => r.outcome === 'resolved')
  assert.ok(resolved.length > 0)
})

test('the same clock yields the same week', () => {
  const again = fixtures(new Date('2026-09-19T18:00:00'))
  assert.deepEqual(again.analytics.summary(), f.analytics.summary())
})

test('the live feed emits valid events', () => {
  const events: unknown[] = []
  const feed = createLiveFeed({
    goal: f.world.goal,
    tickMs: 60_000,
    onEvent: (e) => events.push(e),
  })
  feed.stop()
  assert.ok(events.length >= 6 * 3)
  for (const e of events) LiveEvent.parse(e)
})
