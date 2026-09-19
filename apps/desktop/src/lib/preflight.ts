/**
 * Preflight: the checks that decide whether a session can actually run. Each line is green, amber or
 * red, and a red line carries the command that fixes it. The Settings screen runs this quietly and
 * says nothing while everything passes — a checklist is a fix for a problem, not a fixture.
 */
import { DeskStatus } from '@heli/contracts'
import { api, serverBase } from './api'
import { native } from './native'
import { markSetupDone } from './setup'
import { live } from './live'
import { logger } from './log'

const log = logger('preflight')
const FRAME_STORE = 'http://localhost:9000/minio/health/live'

export type CheckState = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  label: string
  state: CheckState
  detail: string
  /** The command or place that fixes it, when it is not green. */
  fix: string | null
}

async function reachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    // no-cors: an opaque answer still proves something is listening.
    await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

export async function runPreflight(onCheck: (c: Check) => void): Promise<Check[]> {
  const out: Check[] = []
  const push = (c: Check) => {
    out.push(c)
    onCheck(c)
  }
  const base = serverBase()

  // 1. The server.
  const serverUp = base ? await reachable(`${base}/healthz`) : false
  push({
    id: 'server',
    label: 'The server answers',
    state: serverUp ? 'ok' : 'fail',
    detail: base,
    fix: serverUp ? null : 'pnpm --filter @heli/server dev',
  })
  if (!serverUp) return out

  // 2. The database. Goals are what a session needs; the machine's device row is
  //    the server's business now, so it is not counted here.
  const goals = await api.goals()
  const seeded = goals.length > 0
  push({
    id: 'seed',
    label: 'The database is seeded',
    state: seeded ? 'ok' : 'fail',
    detail: `${goals.length} goal${goals.length === 1 ? '' : 's'}`,
    fix: seeded ? null : 'pnpm --filter @heli/server db:reset',
  })

  // 3. The frame store the loop reads frames from.
  const store = await reachable(FRAME_STORE)
  push({
    id: 'store',
    label: 'The frame store is up',
    state: store ? 'ok' : 'fail',
    detail: store ? 'MinIO on :9000' : 'nothing on :9000 — every assessment fails without it',
    fix: store ? null : 'docker compose -f apps/server/docker-compose.yml up -d minio',
  })

  // 4–5. The desk and the rig.
  const status = DeskStatus.safeParse(await api.desk())
  const desk = status.success ? status.data : null
  push({
    id: 'desk',
    label: 'Lumi One is registered',
    state: desk?.desk ? 'ok' : 'fail',
    detail: desk?.desk ? desk.desk.name : 'no desk — the rig registers itself on first run',
    fix: desk?.desk ? null : 'cd apps/edge && uv run heli-rig',
  })
  const fps = desk?.health?.fps ?? 0
  push({
    id: 'rig',
    label: 'The rig’s camera and arm answer',
    state: desk?.connected && fps > 0 ? (desk.desk?.arm ? 'ok' : 'warn') : 'fail',
    detail: !desk?.connected
      ? 'the rig is not connected'
      : `${fps} fps · ${desk.desk?.arm ? `arm ${desk.desk.arm.model}` : 'no arm — aiming is off'}`,
    fix: desk?.connected && fps > 0 ? null : 'cd apps/edge && uv run heli-rig',
  })

  // 6. The model, warmed by one real draft.
  const started = performance.now()
  let model: 'model' | 'local' | 'error' = 'error'
  try {
    model = (await api.draftGoal('Warm-up: finish the problem set by 9'))?.source ?? 'local'
  } catch (e) {
    log.warn('model warm-up failed', String(e))
  }
  const ms = Math.round(performance.now() - started)
  push({
    id: 'model',
    label: 'The model is warm',
    state: model === 'model' ? 'ok' : model === 'local' ? 'warn' : 'fail',
    detail:
      model === 'model'
        ? `answered in ${(ms / 1000).toFixed(1)} s`
        : model === 'local'
          ? 'drafting fell back to local rules'
          : 'the draft call failed',
    fix:
      model === 'model'
        ? null
        : 'set DEEPSEEK_API_KEY in apps/server/.env',
  })

  // 7. The grants.
  const perms = await native.permissions()
  const missing = perms.filter((p) => p.state === 'missing')
  push({
    id: 'grants',
    label: 'macOS grants are held',
    state: !native.available ? 'warn' : missing.length ? 'fail' : 'ok',
    detail: !native.available
      ? 'only checkable in the desktop app'
      : missing.length
        ? `missing: ${missing.map((m) => m.label).join(', ')}`
        : 'all held',
    fix: missing.length ? 'System Settings → Privacy & Security' : null,
  })
  return out
}

/**
 * Back to a startable state: close the open session, forget the local setup, and show setup again.
 */
export async function startOver() {
  live.end()
  try {
    const open = (await api.sessions()).filter((s) => s.endedAt === null)
    await Promise.all(open.map((s) => api.closeSession(s.id)))
  } catch (e) {
    log.warn('could not close the open session', String(e))
  }
  for (const key of ['lumi.setup.region', 'heli.route']) {
    try {
      localStorage.removeItem(key)
    } catch {
      // nothing stored
    }
  }
  markSetupDone(false)
  window.dispatchEvent(new Event('lumi:setup'))
}
