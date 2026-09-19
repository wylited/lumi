/**
 * First-run setup: the goal, the watch, the desk. One person, one desk — nothing to pair.
 *
 * The rig registers itself (it keeps its desk id and token in `~/.heli/rig.json`), so setup reads
 * the desk from `GET /v1/desk` rather than creating one. The session opens when the person reaches
 * the watch step, because frames only attach to an open session and the watch step proves the
 * camera live; "Start watching" then just goes to Live.
 */
import { DEFAULT_POLICY, GoalCreateRequest, type Goal, type GoalDraft } from '@heli/contracts'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { api } from './api'
import { draft as localDraft } from './goals'
import { blankGoal, maxTierFor } from './goals'
import { logger } from './log'

const log = logger('setup')
const DONE_KEY = 'lumi.setup.done'
const REGION_KEY = 'lumi.setup.region'

export function setupDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return true
  }
}

export function markSetupDone(done = true) {
  try {
    if (done) localStorage.setItem(DONE_KEY, '1')
    else localStorage.removeItem(DONE_KEY)
  } catch {
    // per-viewer convenience only
  }
}

/** The server's draft, or the local rules' — and which one it was, so the screen can say so. */
export async function draftGoal(
  sentence: string,
): Promise<{ draft: GoalDraft; fellBack: boolean }> {
  try {
    const remote = await api.draftGoal(sentence)
    if (remote) return { draft: remote, fellBack: false }
  } catch (error) {
    log.warn('server draft failed; drafting locally', String(error))
  }
  const base = blankGoal()
  const d = localDraft(sentence).patch
  return {
    fellBack: true,
    draft: {
      kind: d.kind ?? base.kind,
      objective: d.objective ?? sentence,
      successCriteria: d.successCriteria ?? null,
      timeBudgetMinutes: d.timeBudgetMinutes ?? base.timeBudgetMinutes,
      breakPolicy: d.breakPolicy ?? base.breakPolicy,
      allowedApps: d.allowedApps ?? [],
      blockedApps: d.blockedApps ?? [],
      allowedSites: d.allowedSites ?? [],
      blockedSites: d.blockedSites ?? [],
      permissions: base.permissions,
      automations: [],
      active: true,
      source: 'local',
    },
  }
}

/** Save the edited draft as the goal: update the active one if there is one, else create. */
export async function saveDraft(draft: GoalDraft, existing: Goal | null): Promise<Goal> {
  const parsed = GoalCreateRequest.parse(draft) // strips `source`, which the goals route does not take
  // The draft carries no policy, and the server's default stops at tier 2: without this a goal made
  // here could never speak, whatever its permissions said.
  const policy = { ...(existing?.policy ?? DEFAULT_POLICY), maxTier: maxTierFor(parsed.permissions) }
  const body = { ...parsed, policy }
  return existing ? api.updateGoal(existing.id, body) : api.createGoal(body)
}

export interface Region {
  /** Fractions of the preview, 0–1. */
  x: number
  y: number
  w: number
  h: number
}

export function savedRegion(): Region | null {
  try {
    const raw = localStorage.getItem(REGION_KEY)
    return raw ? (JSON.parse(raw) as Region) : null
  } catch {
    return null
  }
}

export interface Calibration {
  rectMm: { x: number; y: number; w: number; h: number } | null
  poses: number
}

export async function rigCalibration(): Promise<Calibration | null> {
  if (!isTauri()) return null
  return invoke<Calibration | null>('rig_calibration')
}

/**
 * Aim at the centre of the drawn region. The region is a fraction of the preview; the rig's
 * calibrated rectangle turns it into millimetres on the desk, which is what `arm.point` takes.
 */
export async function aimAt(deskId: string, region: Region, cal: Calibration) {
  try {
    localStorage.setItem(REGION_KEY, JSON.stringify(region))
  } catch {
    // stored for the panel only
  }
  const r = cal.rectMm
  if (!r) throw new Error('The arm is not calibrated yet.')
  const x = r.x + (region.x + region.w / 2) * r.w
  const y = r.y + (region.y + region.h / 2) * r.h
  return api.deskAction(deskId, {
    type: 'arm.point',
    payload: { x: Math.round(x), y: Math.round(y) },
  })
}
