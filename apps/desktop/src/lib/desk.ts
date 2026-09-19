/**
 * The desk as the desktop sees it: `GET /v1/desk`, polled while a session is live.
 *
 * Today it answers one question for the rest of the app — is the rig connected? When it is, the rig
 * plays spoken lines on the desk (docs/03-desk-capture.md), so the desktop stays quiet and only shows
 * them. Until the server reports `connected`, the answer is no and the desktop speaks.
 */
import { DeskStatus } from '@heli/contracts'
import { api } from './api'
import { logger } from './log'

const log = logger('desk')
const POLL_MS = 10_000

let status: DeskStatus | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function refresh() {
  const raw = await api.desk()
  if (raw === null) {
    status = null
    return
  }
  const parsed = DeskStatus.safeParse(raw)
  // A partial answer (an older server) is not a connected rig.
  status = parsed.success ? parsed.data : null
  if (!parsed.success)
    log.debug('desk status not in the contract shape yet', parsed.error.issues[0]?.message)
}

export const desk = {
  get: () => status,
  rigConnected: () => status?.connected === true,
  /** Start polling. Returns the stop. */
  watch(): () => void {
    void refresh()
    timer ??= setInterval(() => void refresh(), POLL_MS)
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  },
}
