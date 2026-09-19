import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { ApiToDesktop, DesktopToApi, HELI_SOCKET_PROTOCOL } from '@heli/contracts'
import type { ApiToDesktop as ApiToDesktopMessage } from '@heli/contracts'

import { verifyUserToken } from '../lib/jwt.js'
import { childLogger } from '../logger.js'
import { bindSession, ingestSignals } from '../services/signals.js'

const log = childLogger({ module: 'ws.desktop' })

/**
 * `ws://api/ws/desktop` — the desktop's live transport (§8).
 *
 * This socket is a way **in**, not a way out. Observations, interventions and
 * windows reach the desktop over the SSE channel (`GET /v1/live/:sessionId`);
 * the only thing the server ever sends here is an ack or an error, which is what
 * `ApiToDesktop` says and nothing more. A second outbound channel would be a
 * second place for the live view to be half-right.
 *
 * Every text frame is validated through `DesktopToApi`. The `signals` message is
 * `SignalBatch` verbatim, and it goes to the same `ingestSignals` call as
 * `POST /v1/signals` — one payload, one code path, one window.
 */

/** Heartbeat, same cadence as the device socket (HELI-012). */
const PING_MS = 20_000
const DEAD_MS = 60_000

/** `WebSocket.OPEN`, spelled without importing `ws` for one constant. */
const SOCKET_OPEN = 1

const unauthorized = (message: string): Error => Object.assign(new Error(message), { statusCode: 401 })

/**
 * `token` is accepted in the query *as a fallback*. The desktop is a webview,
 * and a webview cannot set headers on a `WebSocket` any more than a page can —
 * but a nested webview, a test harness or `wscat` may only be able to change the
 * url, and the SSE route already takes its token this way.
 */
const DesktopQuery = z.object({ token: z.string().min(1).optional() })

const splitProtocols = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

/**
 * `Sec-WebSocket-Protocol: heli.v1, <token>` — the same shape the device socket
 * uses (`docs/03-device-contract.md` §3). The token is the value *after* the
 * protocol name, so a client that sends only `heli.v1` has no token and is
 * refused rather than quietly let in.
 *
 * The `ws` server echoes the first requested protocol back, so `heli.v1` is what
 * the client sees in its handshake and the token never becomes the negotiated
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

const desktop: FastifyPluginAsync = async (app) => {
  /** Live sockets, for the log line only — the state below is per connection. */
  let connections = 0

  app.get(
    '/ws/desktop',
    {
      websocket: true,
      schema: { querystring: DesktopQuery },
      /**
       * `?token=` puts a 12h user token in `request.url`, and fastify logs
       * `req.url` at `info` for every request. That one line would put the token
       * in the log stream — the thing `src/logger.ts` exists to prevent and its
       * `redact` list cannot catch, because the secret is inside a url rather
       * than a field named `token`. `GET /v1/live/:sessionId` takes its token
       * the same way and drops these two log lines for the same reason.
       *
       * Nothing is lost: the connection is logged explicitly below, and a 401
       * still reaches the log because the error handler logs its own line.
       */
      logLevel: 'warn',
      /**
       * `onRequest`, not a check inside the handler: `@fastify/websocket`
       * dispatches the upgrade through the normal fastify pipeline and only
       * upgrades in the route handler, so throwing here answers the client with
       * a real `401` before the handshake instead of accepting a socket and
       * then closing it. A bad token is a refusal, not a quiet no-op.
       *
       * `verifyUserToken` also refuses a *device* token: the Pi's 90-day
       * credential must not be a way into a person's signal stream.
       */
      onRequest: async (request) => {
        const token =
          tokenFromProtocols(splitProtocols(request.headers['sec-websocket-protocol'])) ??
          request.query.token ??
          null

        if (token === null) {
          throw unauthorized(
            `A user token is required: Sec-WebSocket-Protocol: ${HELI_SOCKET_PROTOCOL}, <token>`,
          )
        }
        request.userId = verifyUserToken(token)
      },
    },
    (socket, request) => {
      connections += 1
      const openedAt = Date.now()
      let lastSeenAt = openedAt
      let deviceId: string | null = null
      let sessionId: string | null = null
      /** The desktop's own playback state: recorded, and nothing consumes it yet. */
      let playback: { playing: boolean; momentId: string | null } | null = null
      let closing = false

      const send = (message: ApiToDesktopMessage): void => {
        if (closing || socket.readyState !== SOCKET_OPEN) return
        // Nothing else on this socket is serialized (the SSE route is the
        // outbound channel), so the contract is checked here rather than left to
        // the client's parser to notice.
        const validated = ApiToDesktop.safeParse(message)
        if (!validated.success) {
          log.error({ issues: validated.error.issues }, 'refused to send an invalid desktop frame')
          return
        }
        socket.send(JSON.stringify(validated.data))
      }

      const sendError = (code: string, message: string): void => {
        log.debug({ code, deviceId, userId: request.userId }, 'refused a desktop frame')
        send({ t: 'error', code, message })
      }

      log.info({ userId: request.userId, connections }, 'desktop socket connected')

      socket.on('pong', () => {
        lastSeenAt = Date.now()
      })

      /**
       * Ping every 20 s, drop at 60 s of silence. A dead webview that is never
       * dropped holds a listener and a heartbeat forever, and there is no half
       * open socket that a `close` will ever tell us about.
       */
      const heartbeat = setInterval(() => {
        if (closing) return
        if (Date.now() - lastSeenAt > DEAD_MS) {
          log.info({ deviceId, sessionId }, 'desktop socket silent for 60s; dropping it')
          closing = true
          clearInterval(heartbeat)
          socket.terminate()
          return
        }
        socket.ping()
      }, PING_MS)

      /**
       * Frames are handled strictly one at a time. `ingestSignals` is async and a
       * `signals` frame is answered only after it resolves, so two frames
       * chained this way cannot be folded out of order and the acks come back in
       * the order the client sent them.
       */
      let queue: Promise<void> = Promise.resolve()

      const handle = async (text: string): Promise<void> => {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          sendError('unparseable_frame', 'A text frame must be JSON.')
          return
        }

        const parsed = DesktopToApi.safeParse(json)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const where = issue ? issue.path.join('.') : ''
          sendError(
            'invalid_frame',
            `Not a DesktopToApi message${where.length > 0 ? ` (${where})` : ''}: ${issue?.message ?? 'invalid'}`,
          )
          return
        }

        switch (parsed.data.t) {
          case 'hello': {
            deviceId = parsed.data.deviceId
            sessionId = parsed.data.sessionId
            if (deviceId !== null && sessionId !== null) bindSession(deviceId, sessionId)

            log.info(
              { appVersion: parsed.data.appVersion, deviceId, sessionId },
              'desktop hello',
            )
            /**
             * `ApiToDesktop` is `ack | error`, and `DesktopAck.accepted` counts
             * signals — so a handshake, which carries none, acks 0. The union
             * has no hello-specific reply; that is a contract shape, not a
             * choice made here.
             */
            send({ t: 'ack', accepted: 0 })
            return
          }

          case 'signals': {
            const batch = parsed.data
            deviceId = batch.deviceId
            if (batch.sessionId !== null) sessionId = batch.sessionId

            // The same call `POST /v1/signals` makes. This is the promise the
            // shared `SignalBatch` shape exists to keep.
            const { accepted } = await ingestSignals(
              batch.deviceId,
              batch.sessionId ?? sessionId,
              batch.signals,
            )
            send({ t: 'ack', accepted })
            return
          }

          case 'playback': {
            playback = { playing: parsed.data.playing, momentId: parsed.data.momentId }
            log.debug({ deviceId, ...playback }, 'desktop playback state recorded')
            return
          }
        }
      }

      socket.on('message', (raw: unknown, isBinary: boolean) => {
        lastSeenAt = Date.now()

        if (isBinary) {
          // The desktop socket carries JSON only; the tagged binary path is the
          // device's (0x01 video, 0x02 audio) and belongs to HELI-012.
          sendError('binary_not_supported', 'The desktop socket accepts JSON text frames only.')
          return
        }

        queue = queue
          .then(() => handle(frameText(raw)))
          .catch((error: unknown) => {
            log.error({ err: error, deviceId, sessionId }, 'failed to handle a desktop frame')
            sendError('internal_error', 'The server could not handle that frame.')
          })
      })

      socket.on('close', (code: number, reason: Buffer) => {
        closing = true
        clearInterval(heartbeat)
        connections -= 1
        // Everything this connection owned — the binding it set, its playback
        // state, its queue — goes out of scope here. The *session* does not:
        // closing a tab is not ending a session, so `endSignalSession` is
        // deliberately not called. The session is closed by whoever owns it
        // (HELI-013), and its signals are still the ones the next window is
        // made of.
        log.info(
          {
            code,
            reason: reason.toString(),
            deviceId,
            sessionId,
            connections,
            openMs: Date.now() - openedAt,
          },
          'desktop socket closed',
        )
        playback = null
      })
    },
  )
}

export default desktop
