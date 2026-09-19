import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { ApiToDesk, DeskToApi, HELI_SOCKET_PROTOCOL } from '@heli/contracts'
import type { ApiToDesk as ApiToDeskMessage, DeskError } from '@heli/contracts'

import { childLogger } from '../logger.js'
import {
  attachDeskSocket,
  deskRowExists,
  detachDeskSocket,
  recordDeskHealth,
  recordDeskHello,
  resolveActionAck,
  verifyDeskToken,
} from '../services/desk.js'
import type { DeskSocketLike } from '../services/desk.js'

const log = childLogger({ module: 'ws.desk' })

/**
 * `ws://api/ws/desk?token=<deskToken>` — the Mac rig's socket.
 *
 * The rig is a way **in** with a real way **out**. In: `hello` (the desk's caps),
 * `desk.health` (fps, last frame, arm pose, temperature) and `action.ack`. Out:
 * `DeskAction` — `capture`, `stream.start`, `camera.zoom`, `arm.point` and the
 * rest — plus `DeskError` when a frame cannot be used. Actions are *dispatched
 * by the service*, not here: this file attaches the socket, hands the inbound
 * frames to `services/desk.ts`, and owns exactly three things of its own — the
 * heartbeat, the teardown, and the refusals.
 *
 * Three notes for whoever changes this next:
 *
 *   - **`docs/03-desk-capture.md` §"Desk actions" is wrong on one point.** It
 *     says actions are delivered over "the existing desktop socket"
 *     (`ApiToDesktop`). They are not: `ApiToDesktop` is `ack | audio.out |
 *     nudge | error` and has no action member, `packages/contracts/src/desk.ts`
 *     defines `ApiToDesk = DeskAction | DeskError` as *this* socket's outbound
 *     union, and the HELI-044 phase doc says `/ws/desk`. The phase doc wins and
 *     the contracts are law.
 *   - **The same section names `desk.caps` and it does not exist.** The caps
 *     frame is `hello` (`DeskHello`: `deskId`, `agentVersion`, `camera`, `arm`),
 *     which is also what `docs/03-desk-capture.md` §"Caps and health" draws. An
 *     off-contract `desk.caps` frame is answered with a `DeskError` rather than
 *     accepted quietly; see `handleText`.
 *   - **Nothing inbound is binary.** Frames are uploaded over
 *     `POST /v1/desk/frames`; on this socket the bytes travel the other way, as
 *     the tagged PCM `services/desk.ts` may hand to the socket's `send`. A
 *     binary frame *from* the rig is therefore refused, not guessed at.
 */

/** Heartbeat, the same cadence as the desktop and phone sockets. */
const PING_MS = 20_000
const DEAD_MS = 60_000

/** `WebSocket.OPEN`, spelled without importing `ws` for one constant. */
const SOCKET_OPEN = 1

const unauthorized = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 401 })

/**
 * The rig cannot set an `Authorization` header on a `WebSocket` — no browser,
 * runtime or `websockets` client will let it — so HELI-044's phase doc puts the
 * desk token in the query, and that is the documented form:
 * `/ws/desk?token=<deskToken>`. The desktop and phone sockets take the same
 * credential out of band, one transport over.
 */
const DeskQuery = z.object({ token: z.string().min(1).optional() })

const splitProtocols = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

/**
 * `Sec-WebSocket-Protocol: heli.v1, <deskToken>` — the value *after* the
 * protocol name, exactly as `ws/desktop.ts` and `ws/mobile.ts` read it. A client
 * that sends only `heli.v1` has presented no token and is refused rather than
 * quietly let in.
 *
 * The `ws` server echoes the first requested protocol back, so `heli.v1` is what
 * the rig sees in its handshake and the desk token never becomes the negotiated
 * subprotocol.
 */
const tokenFromProtocols = (protocols: readonly string[]): string | null => {
  const index = protocols.indexOf(HELI_SOCKET_PROTOCOL)
  if (index === -1) return null
  const token = protocols[index + 1]
  return token !== undefined && token.length > 0 ? token : null
}

/**
 * A text frame as text. `ws` hands text frames over as a `Buffer`, but the
 * listener is typed against `RawData`, so the other cases are handled rather
 * than assumed away.
 */
const frameText = (raw: unknown): string => {
  if (typeof raw === 'string') return raw
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return String(raw)
}

/**
 * `FastifyRequest.deskId`, set by the `onRequest` hook below.
 *
 * Declared here rather than in a shared file for the reason
 * `src/types/fastify.d.ts` gives: the commit that adds a request member declares
 * its own `declare module 'fastify'` block beside the code that sets it, so two
 * rows never have to edit one augmentation. `userId` and `phoneId` live in
 * `lib/jwt.ts` because their hooks (`requireUser`, `requireMobile`) do; the desk
 * socket's hook is this file.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `/ws/desk`'s `onRequest`. Absent everywhere else. */
    deskId?: string
  }
}

const desk: FastifyPluginAsync = async (app) => {
  /** Live sockets, for the log line only — everything else is per connection. */
  let connections = 0

  app.get(
    '/ws/desk',
    {
      websocket: true,
      schema: { querystring: DeskQuery },
      /**
       * `?token=` puts the desk token in `request.url`, and fastify logs
       * `req.url` at `info` for every request. That one line would put a live
       * credential in the log stream — the thing `src/logger.ts` exists to
       * prevent and its `redact` list cannot catch, because the secret is inside
       * a url rather than in a field named `token`. `ws/desktop.ts` and
       * `GET /v1/live/:sessionId` drop these two lines for the same reason.
       *
       * Nothing is lost: the connection and the close are logged explicitly
       * below, and a 401 still reaches the log because the error handler writes
       * its own line.
       */
      logLevel: 'warn',
      /**
       * `onRequest`, not a check inside the handler: `@fastify/websocket`
       * dispatches the upgrade through the normal fastify pipeline and only
       * upgrades in the route handler, so throwing here answers the rig with a
       * real `401` before the handshake instead of accepting a socket and then
       * closing it. A bad, expired or missing token is a refusal, not a socket
       * that opens, says nothing and dies.
       *
       * The token names a desk and nothing else: `verifyDeskToken` is the only
       * credential this socket accepts, so a user's 12h token — or the desktop's
       * — cannot be replayed here as a rig.
       */
      onRequest: async (request) => {
        const token =
          tokenFromProtocols(splitProtocols(request.headers['sec-websocket-protocol'])) ??
          request.query.token ??
          null

        if (token === null) {
          throw unauthorized(
            `A desk token is required: /ws/desk?token=<deskToken>, or Sec-WebSocket-Protocol: ${HELI_SOCKET_PROTOCOL}, <deskToken>`,
          )
        }

        const deskId = verifyDeskToken(token)

        // A token that names a desk the database no longer has must not open a
        // socket. The rig would connect, look healthy, and every action would be
        // addressed to a row that is gone — the panel would show a connected desk
        // that can never be acted on. One indexed read per upgrade, once per
        // connection, is nothing next to that failure.
        if (!(await deskRowExists(deskId))) {
          throw unauthorized('That desk token no longer names a desk. Run setup again.')
        }

        request.deskId = deskId
      },
    },
    (socket, request) => {
      const deskId = request.deskId
      if (deskId === undefined) {
        // Unreachable: `onRequest` above either sets it or throws. Kept so the
        // rest of this handler does not have to pretend `string | undefined` is
        // a string.
        log.error('desk socket upgraded without a desk id; closing it')
        socket.close(1011, 'no desk')
        return
      }

      /**
       * The socket as the service sees it, and the only view of it that goes on
       * the wire. `send` takes `string | Buffer` because the service may hand
       * tagged PCM (`0x02`) as bytes next to the JSON frames; `ws`'s own `send`
       * accepts both, so the real socket satisfies this structurally and this
       * file never has to import `ws` — which is not a declared dependency of
       * this package.
       */
      const deskSocket: DeskSocketLike = socket

      const openedAt = Date.now()
      let lastSeenAt = openedAt

      /**
       * Whether *this* socket is the one the service holds for this desk.
       * `detachDeskSocket` is called only when it is, so a connection that
       * authenticated and then died before saying hello cannot knock out a newer
       * and live one.
       */
      let attached = false

      let tornDown = false

      /* -- what this socket says ------------------------------------------- */

      const send = (message: ApiToDeskMessage): void => {
        /**
         * The `readyState` is read off the real socket rather than off
         * `deskSocket`, whose `readyState` is optional because the service only
         * needs `send` and `close`. A guard that reads an optional field would
         * treat "this fake has no state" as "not open" and drop the frame
         * silently, which is the one failure a refusal must never have.
         */
        if (tornDown || socket.readyState !== SOCKET_OPEN) return
        // Last check before the wire. `ApiToDesk` is the contract, and a rig
        // that cannot parse a frame we sent has no channel to report it on —
        // this socket is the only one it has, and it is the thing that failed.
        const validated = ApiToDesk.safeParse(message)
        if (!validated.success) {
          log.error({ issues: validated.error.issues }, 'refused to send an invalid desk frame')
          return
        }
        deskSocket.send(JSON.stringify(validated.data))
      }

      /**
       * `{ t:'error', code, message }` — `DeskError`, the second member of
       * `ApiToDesk`. A frame we cannot use is answered, never swallowed: the rig
       * logs the code, and a silent drop would look like a server that is
       * listening while the action it was waiting for never arrives.
       */
      const sendError = (code: string, message: string): void => {
        log.debug({ deskId, code }, 'refused a desk frame')
        const error: DeskError = { t: 'error', code, message }
        send(error)
      }

      /* -- teardown --------------------------------------------------------- */

      /**
       * Everything this connection owns, released exactly once: the service's
       * attachment to the socket, the heartbeat's interval **and** its deadline
       * timer, and the log line. A rig that is yanked out must read as
       * disconnected immediately — `isDeskConnected` is what the desktop's desk
       * panel and `DeskStatus.connected` are built from, and an attachment that
       * outlived its socket would keep a dead rig looking online while every
       * action sent to it went nowhere.
       *
       * `tornDown` rather than a flag that also blocks sends: after `terminate`
       * the `readyState` is no longer OPEN, so `send` is already a no-op, and a
       * second call — an `error` followed by a `close`, which is the normal
       * order on a dropped cable — must not detach the same socket twice.
       */
      const teardown = (code: number, reason: string): void => {
        if (tornDown) return
        tornDown = true

        clearInterval(heartbeat)
        clearTimeout(dropTimer)
        dropTimer = undefined

        if (attached) {
          detachDeskSocket(deskId, deskSocket)
          attached = false
        }

        connections -= 1
        log.info(
          {
            code,
            reason,
            deskId,
            connections,
            openMs: Date.now() - openedAt,
          },
          'desk socket closed',
        )
      }

      /* -- text frames ------------------------------------------------------ */

      const handleText = async (text: string): Promise<void> => {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          sendError('unparseable_frame', 'A text frame must be JSON.')
          return
        }

        const parsed = DeskToApi.safeParse(json)
        if (!parsed.success) {
          /**
           * `unknown_frame` versus `invalid_frame`, decided by the contract
           * rather than by a list of names kept in this file: a discriminated
           * union that fails on the discriminator itself reports
           * `invalid_union_discriminator`, so anything else is a known frame
           * with a wrong shape. `desk.caps` — which `docs/03-desk-capture.md`
           * §"Caps and health" still shows and the contracts replaced with
           * `hello` — lands in the first case and is told so by name.
           */
          if (parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator')) {
            sendError(
              'unknown_frame',
              'That frame is not part of the desk contract; a rig sends hello, desk.health or action.ack.',
            )
            return
          }

          const issue = parsed.error.issues[0]
          const where = issue === undefined ? '' : issue.path.join('.')
          sendError(
            'invalid_frame',
            `Not a DeskToApi message${where.length > 0 ? ` (${where})` : ''}: ${issue?.message ?? 'invalid'}`,
          )
          return
        }

        const message = parsed.data

        switch (message.t) {
          case 'hello': {
            /**
             * The frame carries a `deskId` and the credential already named the
             * desk. The credential wins: a payload field must never be able to
             * re-point an authenticated socket at another desk's row. The
             * disagreement is worth a log line rather than a refusal, because
             * the connection is provably the authenticated desk's either way.
             */
            if (message.deskId !== deskId) {
              log.warn(
                { authenticated: deskId, claimed: message.deskId },
                'hello named a different desk id; the authenticated one stands',
              )
            }

            /**
             * Attach **before** the awaited write, then record.
             *
             * The order looks like it should be the other way round — caps are
             * what say whether `arm.point` will do anything — but `recordDeskHello`
             * hits the database, and a rig that sends `hello` and `desk.health`
             * back to back has its second frame handled while that write is still
             * in flight. `recordDeskHealth` needs a live socket to attach the
             * report to, so recording first would drop the first heartbeat of
             * every connection and answer `hello_required` to a rig that had just
             * said hello.
             *
             * A connection that has authenticated with a desk token *is* this
             * desk's socket, so attaching here is not a claim about its caps; the
             * caps land a moment later on the row.
             */
            if (!attached) {
              attachDeskSocket(deskId, deskSocket)
              attached = true
            }

            try {
              await recordDeskHello(deskId, message)
            } catch (error: unknown) {
              // A database hiccup is our fault, not the rig's, and the honest
              // outcome is a desk whose caps are stale — not a live rig the panel
              // shows as absent and the service cannot reach. So the attachment
              // above stands either way.
              log.error({ err: error, deskId }, 'could not record a desk hello')
            }

            log.info(
              {
                deskId,
                agentVersion: message.agentVersion,
                camera: message.camera?.model ?? null,
                arm: message.arm?.model ?? null,
                connections,
              },
              'desk hello',
            )
            return
          }

          case 'desk.health': {
            /**
             * Health is only recorded for a desk whose socket the service holds,
             * and a socket is held from `hello` onwards. A `desk.health` before
             * `hello` would therefore be dropped on the floor by the service
             * while looking, from the rig's side, exactly like a healthy
             * heartbeat — so it is refused instead of swallowed. HELI-045 has the
             * rig say hello first, so this fires only for a client that got the
             * order wrong.
             */
            if (!attached) {
              sendError(
                'hello_required',
                'Send hello before desk.health, so the server knows which desk this socket belongs to.',
              )
              return
            }

            // The live numbers behind `DeskStatus.health`, and what the panel's
            // "capture fps / last frame time" reads. Not persisted: health is
            // about the connection that just reported it.
            recordDeskHealth(deskId, message)
            log.debug({ deskId, fps: message.fps, lastFrameAt: message.lastFrameAt }, 'desk health')
            return
          }

          case 'action.ack': {
            /**
             * The other half of the action lifecycle, and the reason this socket
             * exists: the service persists an action, sends it here, and waits
             * for exactly this frame. Matching it to the pending action — the
             * 10s timeout, the one retry, failing it with `ack_timeout` — is the
             * service's business; all this socket does is deliver the ack with
             * the desk id the credential established.
             */
            resolveActionAck(deskId, message)
            log.debug(
              { deskId, actionId: message.actionId, status: message.status, error: message.error },
              'desk acked an action',
            )
            return
          }
        }
      }

      /* -- the heartbeat ---------------------------------------------------- */

      /**
       * A deadline timer instead of a timestamp compared inside the interval:
       * the two things a long-lived server has to get right here are that a rig
       * which stops answering is dropped, and that neither timer outlives the
       * connection — a leaked 20s interval per connection is a real bug in a
       * process that stays up for weeks.
       *
       * The deadline is re-armed by anything the rig says, a message or a pong,
       * so a healthy rig is never dropped and a dead one goes within `DEAD_MS`
       * of its last word.
       */
      let dropTimer: ReturnType<typeof setTimeout> | undefined

      const armDropTimer = (): void => {
        clearTimeout(dropTimer)
        if (tornDown) return
        dropTimer = setTimeout(() => {
          log.info(
            { deskId, silentMs: Date.now() - lastSeenAt },
            'desk socket stopped answering; dropping it',
          )
          /**
           * Torn down *before* the terminate, not after: `ws` closes the socket
           * and emits `close`, but the release must not depend on that event
           * arriving. Detaching here is what makes a rig that was unplugged read
           * as disconnected at the deadline rather than whenever the transport
           * gets around to noticing. The second call is a no-op.
           */
          teardown(1006, 'heartbeat timeout')
          socket.terminate()
        }, DEAD_MS)
      }

      const heartbeat = setInterval(() => {
        if (tornDown || socket.readyState !== SOCKET_OPEN) return
        socket.ping()
      }, PING_MS)

      /* -- what this socket hears ------------------------------------------- */

      socket.on('pong', () => {
        lastSeenAt = Date.now()
        armDropTimer()
      })

      /**
       * Frames are handled strictly one at a time and in arrival order, which is
       * not only hygiene: `hello` is what attaches the socket, and a
       * `desk.health` that overtook it would be recorded for a desk the service
       * has not been told is live yet.
       */
      let queue: Promise<void> = Promise.resolve()

      socket.on('message', (raw: unknown, isBinary: boolean) => {
        lastSeenAt = Date.now()
        armDropTimer()

        if (isBinary) {
          // The desk socket carries JSON only. Frames go up over
          // `POST /v1/desk/frames`, and the tagged binary path (0x02 PCM) runs
          // the other way — from the service, out. Guessing at an inbound blob
          // would be inventing a second frame path nothing needs.
          sendError(
            'binary_not_supported',
            'The desk socket accepts JSON text frames only; upload frames with POST /v1/desk/frames.',
          )
          return
        }

        queue = queue
          .then(() => handleText(frameText(raw)))
          .catch((error: unknown) => {
            log.error({ err: error, deskId }, 'failed to handle a desk frame')
            sendError('internal_error', 'The server could not handle that frame.')
          })
      })

      /**
       * A transport error closes the connection too, but not always with a
       * `close` event first, so teardown is called from both — it is idempotent.
       */
      socket.on('error', (error: unknown) => {
        log.warn({ err: error, deskId }, 'desk socket errored')
        teardown(1006, 'socket error')
      })

      socket.on('close', (code: number, reason: Buffer) => {
        teardown(code, reason.toString())
      })

      /* -- connected -------------------------------------------------------- */

      armDropTimer()
      connections += 1

      log.info(
        { deskId, connections, remote: request.ip },
        'desk socket connected, waiting for hello',
      )
    },
  )
}

export default desk
