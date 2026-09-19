import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import type { LiveEvent, Observation } from '@heli/contracts'

import { REPLAY_LIMIT, liveEventName, subscribeWithReplay, subscriberCount } from '../lib/bus.js'
import { bearerToken, verifyUserToken } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { toApiObservations } from '../lib/rows.js'
import { childLogger } from '../logger.js'

const log = childLogger({ module: 'live' })

/**
 * The server end of the SSE channel the desktop already consumes
 * (`apps/desktop/src/lib/api.ts`, `subscribe()`).
 *
 * The wire shape is not a choice — it is what that file parses: the token rides
 * in the query string because `EventSource` cannot set an `Authorization`
 * header, `event:` carries the `LiveEvent` discriminant, and `data:` carries
 * *only* `event.data`, because the client rebuilds the envelope from the
 * `event:` name. Sending the whole `{ event, data }` object would parse as a
 * live event with an `event` key inside its observation and be dropped.
 */

/** How often a comment is written into an otherwise idle stream. */
const HEARTBEAT_MS = 15_000

/**
 * The reconnect delay handed to the client. `EventSource` retries on its own
 * and the desktop only logs the error, so the value here is what a browser will
 * actually wait: three seconds, short enough that a restarted dev server is not
 * noticed, long enough not to hammer a server that is coming back up.
 */
const RETRY_MS = 3_000

const fail = (statusCode: number, message: string): Error =>
  Object.assign(new Error(message), { statusCode })

const LiveParams = z.object({ sessionId: z.string().min(1) })

/**
 * `token` is optional *here* on purpose: a request with no query token may
 * still carry an `Authorization` header, and the 401 for a request with neither
 * is the handler's business, not the validator's. A missing token answered as a
 * 400 "validation failed" would be a worse description of the same refusal.
 */
const LiveQuery = z.object({ token: z.string().min(1).optional() })

/**
 * The last `REPLAY_LIMIT` persisted observations for a session, oldest first —
 * the cold-process answer to "what happened before I opened this window".
 * `orderBy desc` with `take` is what makes it the *last* twenty rather than the
 * first; the client renders them in the order they happened, so the page is
 * reversed before mapping. Fewer than twenty rows can come back, because
 * `toApiObservations` drops rows it cannot read as contract shapes rather than
 * inventing fields for them.
 */
async function recentObservations(sessionId: string): Promise<Observation[]> {
  const rows = await prisma.observation.findMany({
    where: { sessionId },
    orderBy: { ts: 'desc' },
    take: REPLAY_LIMIT,
  })
  return toApiObservations(rows.reverse())
}

const live: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/live/:sessionId',
    {
      /**
       * A bearer token arrives in the query string on this route, and fastify
       * logs `req.url` at `info` for every request. That single line would put a
       * 12h user token in the log stream — the exact thing `src/logger.ts`
       * exists to prevent, and something its `redact` list cannot catch, since
       * the secret is inside a url rather than a field called `token`.
       *
       * `logLevel: 'warn'` drops the incoming-request and request-completed
       * lines for this route alone. Nothing is lost: the connection is logged
       * explicitly below with the session and the subscriber count and no url,
       * and a 401 still reaches the log, because the error handler logs errors
       * itself at `warn` and attaches no url to them.
       */
      logLevel: 'warn',
      schema: {
        params: LiveParams,
        querystring: LiveQuery,
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params

      /**
       * Two ways in, header first: the query parameter is what the desktop's
       * `EventSource` uses, the header is what `curl` and any browser-side
       * `fetch` use, and when a caller sends both the header is the deliberate
       * one — it is also the one that never reaches an access log.
       *
       * `verifyUserToken` refuses a device token, so the Pi cannot attach to a
       * person's live channel with the credential it holds.
       */
      const token = bearerToken(request.headers.authorization) ?? request.query.token
      if (!token) throw fail(401, 'A bearer token is required')
      verifyUserToken(token)

      /**
       * Everything above this line can still be a normal JSON response; the 401
       * for a bad token lands before the socket is taken over, so a rejected
       * client gets `{ error }` and a closed connection rather than a stream
       * that opens and then says nothing.
       */
      reply.hijack()

      /**
       * `@fastify/cors` is registered on the root instance with `origin: true`
       * (it reflects the caller's `Origin`) but it installs its headers through
       * the normal reply pipeline, and `reply.hijack()` takes the reply away
       * from that pipeline.
       *
       * Measured, not assumed: for identical requests carrying
       * `Origin: tauri://localhost`, an ordinary route answers
       * `access-control-allow-origin: tauri://localhost` while this one
       * answered with no CORS header at all.
       *
       * That failure is silent. The desktop reaches this channel from the Tauri
       * webview's own origin, so a browser or WebView blocks the response and
       * the only reaction is `es.onerror = () => log.debug('live channel
       * reconnecting')` — the live view would claim to be connected and never
       * update a single window. So the header is written by hand here,
       * mirroring what the plugin does for every other route: echo the caller's
       * origin, and `*` when the request carries none (which is not a
       * cross-origin request at all). The token is still the gate; this only
       * says which origins may read a stream they already had to authenticate
       * for.
       */
      const origin = request.headers.origin
      const headers: Record<string, string> = {
        'content-type': 'text/event-stream',
        // `no-cache` and `no-transform`, plus the two proxy switches below: an
        // intermediary that buffers this stream delivers it in one lump when
        // the connection closes, which is indistinguishable from a server that
        // sends nothing at all.
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': origin ?? '*',
      }
      // Reflecting the origin makes this response origin-dependent, so a shared
      // cache has to key on it. `*` is the same answer for everyone and needs
      // no `vary` — which is also what the plugin does for a reflected origin.
      if (origin) headers.vary = 'origin'

      const raw = reply.raw
      raw.writeHead(200, headers)
      // Event frames are tiny and latency is the entire product here, so wait
      // for nothing. `flushHeaders` matters on a session with no backlog: with
      // no reply written yet, the client's `open` would otherwise be delayed
      // until the first heartbeat, 15 s later.
      raw.socket?.setNoDelay(true)
      raw.flushHeaders()

      let closed = false
      let frameId = 0
      /** Set while the cold-start replay awaits the database; see the listener. */
      let replaying = false
      const deferred: LiveEvent[] = []

      const write = (chunk: string): void => {
        if (closed) return
        raw.write(chunk)
      }

      /**
       * One SSE frame. `id:` is a per-connection counter — the client ignores
       * it today, but a browser resends it as `Last-Event-ID` after a drop, and
       * a per-connection number is the honest value to put there.
       *
       * `JSON.stringify` never emits a raw newline, so a payload is always
       * exactly one `data:` line.
       */
      const send = (event: LiveEvent): void => {
        frameId += 1
        write(
          `id: ${frameId}\nevent: ${liveEventName(event)}\ndata: ${JSON.stringify(event.data)}\n\n`,
        )
      }

      // Subscribe before replaying anything. `subscribeWithReplay` snapshots
      // the ring and registers this listener as one synchronous step, so an
      // observation published while the replay below is being written is not
      // lost — it is either in the snapshot or waiting in `deferred`.
      const subscription = subscribeWithReplay(sessionId, (event) => {
        // Held while the database replay is in flight, then flushed in order.
        // Without this the first live event would overtake twenty older ones
        // and the client's window would jump backwards.
        if (replaying) deferred.push(event)
        else send(event)
      })

      // A proxy must not be the reason a stream dies. An SSE stream is idle by
      // nature — silence is the default in this product — and a comment line is
      // the only way to say "still here" without the client seeing an event.
      const heartbeat = setInterval(() => {
        write(': ping\n\n')
      }, HEARTBEAT_MS)

      const cleanup = (): void => {
        if (closed) return
        closed = true
        // Both of these are per-connection allocations. A dev server is long
        // lived and a window that is opened and closed all day would otherwise
        // pile up one interval and one dead listener per visit.
        clearInterval(heartbeat)
        subscription.unsubscribe()
        log.info({ sessionId, subscribers: subscriberCount(sessionId) }, 'live client disconnected')
      }

      // The client hanging up. `close` on the request fires when the connection
      // goes, not when the (bodyless) request is read, so this is the real
      // disconnect signal and the stream is never torn down early by it.
      request.raw.on('close', cleanup)

      // A write into a socket the client already closed surfaces as an error on
      // the response. With no listener, node raises it as an uncaught exception
      // and the whole dev server dies with one closed browser tab.
      raw.on('error', (error: Error) => {
        log.debug({ sessionId, err: error }, 'live stream socket closed with an error')
        cleanup()
      })

      log.info({ sessionId, subscribers: subscriberCount(sessionId) }, 'live client connected')

      write(`retry: ${RETRY_MS}\n\n`)

      /**
       * Replay, so a window opened now is not blank.
       *
       * The ring is the fast path and covers everything published since this
       * process started. A cold process — every restart, and every run until
       * the observation loop writes its first row — has an empty ring while the
       * session still has history, so the backlog comes from the database
       * instead. The database is only consulted when the ring is empty: the
       * ring is a strict subset of what is stored, and replaying both would
       * duplicate every event for a client that reconnected.
       */
      if (subscription.replay.length > 0) {
        for (const event of subscription.replay) send(event)
      } else {
        replaying = true
        try {
          const backlog = await recentObservations(sessionId)
          for (const observation of backlog) {
            send({ event: 'observation', data: observation })
          }
        } catch (error) {
          // A live channel outlives a database hiccup. The backlog is a
          // courtesy; the stream is the product, and headers are already on the
          // wire, so there is no other answer to give.
          log.error({ sessionId, err: error }, 'could not read the observation backlog')
        } finally {
          replaying = false
          for (const event of deferred) send(event)
          deferred.length = 0
        }
      }
    },
  )
}

export default live
