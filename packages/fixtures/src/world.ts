import type { Device, Goal, SessionDetail } from '@heli/contracts'
import { DEVICE_ID, SEED_SESSION_ID, buildSession, seedGoal } from './build.js'
import { proceduralStory, rng, seedStory } from './story.js'

export interface World {
  now: Date
  goal: Goal
  device: Device
  /** Newest first, like `GET /v1/sessions`. */
  sessions: SessionDetail[]
}

/**
 * Where sessions start on each of the past days, as hour offsets. Days with more than one sit
 * morning and evening; the weekend is lighter. Deterministic: the same week every time.
 */
const WEEK: Array<Array<[hour: number, minutes: number]>> = [
  [
    [9.5, 52],
    [15, 44],
    [20.25, 38],
  ],
  [
    [10, 48],
    [19.5, 55],
  ],
  [
    [8.75, 35],
    [14.5, 50],
    [21, 30],
  ],
  [[11, 46]],
  [
    [9.25, 50],
    [16, 42],
  ],
  [
    [13.5, 58],
    [20, 34],
  ],
  [[10.5, 40]],
]

function minuteFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000)
}

export function buildWorld(nowInput: Date = new Date()): World {
  const now = minuteFloor(nowInput)
  const goal = seedGoal(new Date(now.getTime() - 8 * 86_400_000))
  const sessions: SessionDetail[] = []

  // Today: the seeded session, finished a little while ago.
  const seedStart = new Date(now.getTime() - 55 * 60_000)
  sessions.push(buildSession(SEED_SESSION_ID, seedStart, seedStory(), goal).detail)

  const rand = rng(42)
  WEEK.forEach((day, daysAgo) => {
    day.forEach(([hour, minutes], i) => {
      const start = new Date(now)
      start.setDate(start.getDate() - (daysAgo + 1))
      start.setHours(Math.floor(hour), Math.round((hour % 1) * 60) + Math.floor(rand() * 8), 0, 0)
      const id = `sess_d${daysAgo + 1}_${i + 1}`
      sessions.push(
        buildSession(id, start, proceduralStory(1000 + daysAgo * 10 + i, minutes), goal).detail,
      )
    })
  })

  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const device: Device = {
    id: DEVICE_ID,
    name: 'Desk 1',
    caps: {
      camera: 'imx708',
      mics: 2,
      speaker: true,
      shutter: true,
      ptz: false,
      transports: ['ws', 'mjpeg'],
      audio: true,
      resolutions: [
        [1280, 720],
        [1920, 1080],
      ],
      fps: [5, 15],
    },
    state: 'idle',
    online: true,
    lastSeenAt: new Date(now.getTime() - 20_000).toISOString(),
    createdAt: new Date(now.getTime() - 8 * 86_400_000).toISOString(),
  }

  return { now, goal, device, sessions }
}

export const PAIRING_CODE = 'HELI-DEMO'
