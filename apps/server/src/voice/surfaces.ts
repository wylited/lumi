import { childLogger } from '../logger.js'
import { createDeskSenders, type DeskSocket, type DeskSocketLookup } from '../observe/outbound.js'
import type { LoopSenders } from '../observe/outbound.js'
import { attachedDeskSocket } from '../services/desk.js'
import { phoneAway } from '../services/mobile.js'
import { desktopSocketFor } from '../ws/live-desktop.js'
import { mobileSocketFor } from '../ws/live-mobile.js'

/**
 * The three surfaces a line can reach, in one place.
 *
 * Two callers need the same routing: the loop (`observe/runtime.ts`, through the
 * composition root in `index.ts`) and the manual `POST /v1/sessions/:id/speak`.
 * Building them twice would let the two drift — a line the loop delivers that
 * the button does not, or the reverse — which is the kind of difference nobody
 * finds until a demo.
 *
 * The surfaces are lookups, never sockets: `observe/outbound.ts` owns the
 * ordering and the refusal, and this file owns nothing but which modules answer.
 */

const log = childLogger({ module: 'voice.surfaces' })

/** The desktop app: where the person sits and looks. */
export const desktopSurface: DeskSocketLookup = (sessionId) => desktopSocketFor(sessionId)

/**
 * The rig, on the same Mac, started before the demo and attached for the whole
 * session. Its socket takes `string | Buffer` (`services/desk.ts`), so tagged PCM
 * goes down it exactly as it goes down the desktop's — the rig's own speaker is
 * `afplay`, which is what `heli-rig --doctor` checks.
 */
const rigSurface: DeskSocketLookup = () => {
  const socket = attachedDeskSocket()
  if (socket === null) return null
  const surface: DeskSocket = {
    send: (payload) => {
      try {
        socket.send(JSON.stringify(payload))
        return true
      } catch (error) {
        log.warn({ err: error }, 'could not write to the rig')
        return false
      }
    },
    sendBinary: (bytes) => {
      try {
        socket.send(bytes)
        return true
      } catch (error) {
        log.warn({ err: error }, 'could not write PCM to the rig')
        return false
      }
    },
  }
  return surface
}

/** The phone, when one is paired. */
export const phoneSurface: DeskSocketLookup = (sessionId) => mobileSocketFor(sessionId)

/** The person's own motion says whether the desk was left. */
export const awayFromDesk = (sessionId: string): boolean => phoneAway(sessionId)

/** The surfaces, with the routing `createDeskSenders` documents. */
export function createLoopSenders(): LoopSenders {
  return createDeskSenders({
    desk: desktopSurface,
    rig: rigSurface,
    phone: phoneSurface,
    away: awayFromDesk,
    logger: log,
  })
}
