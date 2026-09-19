import type { FastifyPluginAsync } from 'fastify'

import { ApiToDevice, DeviceToApi, HELI_SOCKET_PROTOCOL, LiveEvent, MEDIA_TAG } from '@heli/contracts'
import type {
  ApiToDevice as ApiToDeviceMessage,
  AudioStreamSpec,
  DeviceState,
  MediaState,
  MediaStreamState,
  VideoStreamSpec,
} from '@heli/contracts'

import { publish as publishLive } from '../lib/bus.js'
import { verifyDeviceToken } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { childLogger } from '../logger.js'
import { touchDevice } from '../routes/devices.js'
import {
  FrameRejectedError,
  endMediaSession,
  ingestAudioChunk,
  ingestVideoFrame,
} from '../services/frames.js'
import { bindSession, endSignalSession } from '../services/signals.js'
import { closeSession, openSession } from '../services/session.js'
import { connectionCount, registerDevice, unregisterDevice, updateDevice } from './registry.js'

const log = childLogger({ module: 'ws.device' })

/**
 * `/ws/device` — the Pi's socket, and the only place frames, audio and desk
 * signals enter the server.
 *
 * It is a way **in** with a small way **out**: `ApiToDevice` is exactly
 * `session.start`, `audio.out`, `command`, `policy.update`, `error`,
 * `session.stop`, and nothing here sends anything that is not one of those six.
 *
 * Three things about this socket are worth reading before changing it:
 *
 *   - **There are two binary paths.** `docs/03-device-contract.md` §5 makes the
 *     trigger path *untagged* — `{t:'frame',seq,ts,trigger}` and then the raw
 *     JPEG, with nothing in between — while §6 makes the media path *tagged*,
 *     first byte `0x01` video / `0x02` audio / `0x03` meta. Both are handled, and
 *     the first byte is what tells them apart: a raw JPEG starts `0xFF 0xD8` and
 *     a tag never does. The phase doc for this row mentions only the tagged
 *     path; a Pi written from the device contract would have had every trigger
 *     frame rejected. See `handleBinary`.
 *   - **`hello` has no acknowledgement, and one must not be invented.**
 *     `ApiToDevice` has no ack member and §3's "You receive" lists the same six
 *     frames, so there is nothing an ack could be. Acceptance is observable
 *     instead: the socket stays open, the registry holds the device with the caps
 *     it reported, `Device.lastSeenAt` is stamped so the app shows it online, and
 *     a following `session.open` produces a real `session.start`.
 *   - **Closing this socket is what releases the session's in-memory state.**
 *     `endMediaSession` and `endSignalSession` have no other caller: without the
 *     teardown below, a session leaks its frame ring, its signal ring and its
 *     hub subscribers until the process restarts.
 */

/** Heartbeat: a ping every 20 s, and a socket that has said nothing at all for 60 s is gone. */
const PING_MS = 20_000
const DEAD_MS = 60_000

/**
 * `Device.lastSeenAt` is written at most this often.
 *
 * `routes/devices.ts` derives `online` from it against a 90 s window, so the
 * stamp only has to be fresher than 90 s — and a live media stream is 8 frames a
 * second, which would otherwise be 8 row updates a second to keep a boolean
 * true. 10 s is nine times inside the window and one write a minute for an idle
 * device. `hello` deliberately does not use it: see `stampSeenNow`.
 */
const TOUCH_INTERVAL_MS = 10_000

/** `WebSocket.OPEN`. See `ws/registry.ts` for why this is spelled out. */
const SOCKET_OPEN = 1

/** Start-of-image: the first two bytes of every JPEG, and how §5's path is recognised. */
const JPEG_SOI_0 = 0xff
const JPEG_SOI_1 = 0xd8

const unauthorized = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 401 })

const splitProtocols = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

/**
 * `Sec-WebSocket-Protocol: heli.v1, <credential>` — the value *after* the
 * protocol name. A client that sends only `heli.v1` has presented no credential
 * and is refused rather than quietly let in.
 *
 * The `ws` server echoes the first requested protocol back, so `heli.v1` is what
 * the device sees in its handshake and the credential never becomes the
 * negotiated subprotocol.
 */
const credentialFromProtocols = (protocols: readonly string[]): string | null => {
  const index = protocols.indexOf(HELI_SOCKET_PROTOCOL)
  if (index === -1) return null
  const credential = protocols[index + 1]
  return credential !== undefined && credential.length > 0 ? credential : null
}

/* ---- reading a frame off the socket -------------------------------------- */

/**
 * A binary frame as bytes. `ws` hands binary over as a `Buffer`, but the
 * listener is typed against `RawData`, so the other cases are handled rather
 * than assumed away.
 */
const frameBytes = (raw: unknown): Uint8Array => {
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return Buffer.concat(raw as readonly Uint8Array[])
  return new Uint8Array(0)
}

/** A text frame as text. */
const frameText = (raw: unknown): string => {
  if (typeof raw === 'string') return raw
  return Buffer.from(frameBytes(raw)).toString('utf8')
}

const describeByte = (value: number | undefined): string =>
  value === undefined ? 'nothing' : `0x${value.toString(16).padStart(2, '0')}`

/**
 * `seq:17` — the `ref` shape §3's example error carries. Only the trigger path
 * has a device-assigned `seq` to quote back; the tagged path has none, so its
 * errors go out without a `ref` rather than with an invented one.
 */
const seqRef = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const seq = (value as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isInteger(seq) ? `seq:${seq}` : undefined
}

const statusCodeOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : null
}

/**
 * What a device may be told about a failure. A 4xx message from the service
 * layer was written to be read by a client; anything else is ours, and a stack
 * trace or a Prisma error must never reach a Pi (§11: "you never send us one").
 */
const clientMessageOf = (error: unknown, fallback: string): string => {
  const status = statusCodeOf(error)
  if (status !== null && status >= 400 && status < 500 && error instanceof Error) {
    return error.message
  }
  return fallback
}

/* ---- the credential ------------------------------------------------------- */

const deviceIdFromToken = (credential: string): string | null => {
  try {
    return verifyDeviceToken(credential)
  } catch {
    // Not a token. It may still be a pairing code — see `authenticate`.
    return null
  }
}

/**
 * Accepts **both** credential forms the two documents disagree about:
 *
 *   - the **pairing token** this row's phase doc names and `POST
 *     /v1/devices/pair` hands out (90 days, `typ: device`);
 *   - the **pairing code** (`HELI-XXXXXX`) that `docs/03-device-contract.md` §1
 *     and `docs/01-contracts.md` §6 both put in this exact header.
 *
 * The edge team writes the Pi from the device contract, so a server that only
 * took tokens would refuse every real device; a server that only took codes
 * would break the token the pair route already issues. Both is the only answer
 * that does not make one of the two documents wrong.
 *
 * The code is matched exactly, the way `POST /v1/devices/pair` matches it. Being
 * cleverer here — case-folding, trimming — would mean a code that pairs over
 * HTTP and fails on the socket, which is a mystery nobody needs.
 *
 * The token path re-reads the device row: a token naming a device that was
 * deleted would otherwise authenticate, keep a socket open and silently update
 * nothing, because every write downstream is an `updateMany`.
 */
async function authenticate(credential: string): Promise<string> {
  const fromToken = deviceIdFromToken(credential)
  if (fromToken !== null) {
    const row = await prisma.device.findUnique({
      where: { id: fromToken },
      select: { id: true },
    })
    if (row !== null) return row.id
    throw unauthorized('That token names a device that no longer exists')
  }

  const row = await prisma.device.findUnique({
    where: { code: credential },
    select: { id: true },
  })
  if (row !== null) return row.id

  throw unauthorized('Invalid device credential')
}

/* ---- the route ------------------------------------------------------------ */

const device: FastifyPluginAsync = async (app) => {
  app.get(
    '/ws/device',
    {
      websocket: true,
      /**
       * `onRequest`, not a check inside the handler: `@fastify/websocket`
       * dispatches the upgrade through the normal fastify pipeline and only
       * upgrades in the route handler, so throwing here answers the client with
       * a real `401` before the handshake. A bad credential is a refusal, not a
       * socket that opens and is then closed.
       *
       * Nothing here is in the url, so this route keeps the default log level:
       * no credential reaches `req.url` and therefore none reaches the log.
       */
      onRequest: async (request) => {
        const credential = credentialFromProtocols(
          splitProtocols(request.headers['sec-websocket-protocol']),
        )
        if (credential === null) {
          throw unauthorized(
            `A device credential is required: Sec-WebSocket-Protocol: ${HELI_SOCKET_PROTOCOL}, <pairing-token|pairing-code>`,
          )
        }
        request.deviceId = await authenticate(credential)
      },
    },
    (socket, request) => {
      const deviceId = request.deviceId
      if (deviceId === undefined) {
        // Unreachable: `onRequest` above either sets it or throws. Kept so the
        // rest of this handler does not have to pretend `string | undefined` is
        // a string.
        log.error('device socket upgraded without a device id; closing it')
        socket.close(1011, 'no device')
        return
      }

      const openedAt = Date.now()

      /* -- what this connection knows -------------------------------------- */

      let deviceState: DeviceState | null = null
      let sessionId: string | null = null
      let announced: { video: VideoStreamSpec; audio: AudioStreamSpec } | null = null
      let mediaState: MediaState = 'idle'
      /**
       * The `frame` message that must be followed *immediately* by a raw JPEG
       * (§5). Set by `frame`, spent by the very next binary frame, and cleared by
       * any other text frame — a stale flag must not accept an unrelated blob.
       */
      let pendingFrame: { seq: number; ts: string } | null = null

      /** Server-assigned `seq` for tagged video: §6's frames carry none. */
      let mediaSeq = 0

      /** Everything `MediaStreamState` is built from, and only what is real. */
      let bytesIn = 0
      let bytesOut = 0
      let lastFrameAt: string | null = null
      let audioLevel = 0
      let deviceFps = 0

      let tornDown = false
      let lastSeenAt = Date.now()
      let lastTouchedAt = 0

      /* -- the two things this socket needs to send ------------------------ */

      const send = (message: ApiToDeviceMessage): void => {
        if (socket.readyState !== SOCKET_OPEN) return
        // Last check before the wire. The union is the contract, and a device
        // that cannot parse a frame we sent has no way to report it.
        const validated = ApiToDevice.safeParse(message)
        if (!validated.success) {
          log.error({ deviceId, issues: validated.error.issues }, 'refused to send an invalid frame')
          return
        }
        const text = JSON.stringify(validated.data)
        socket.send(text)
        bytesOut += Buffer.byteLength(text)
      }

      const sendError = (code: string, message: string, ref?: string): void => {
        log.debug({ deviceId, sessionId, code, ref }, 'refused a device frame')
        send(ref === undefined ? { t: 'error', code, message } : { t: 'error', code, message, ref })
      }

      /* -- device bookkeeping ---------------------------------------------- */

      /**
       * The throttled stamp, on every inbound message. Fire and forget: a
       * database hiccup must not stop a frame being handled.
       */
      const stampSeen = (): void => {
        const now = Date.now()
        if (now - lastTouchedAt < TOUCH_INTERVAL_MS) return
        lastTouchedAt = now
        void touchDevice(deviceId).catch((error: unknown) => {
          log.warn({ err: error, deviceId }, 'could not stamp the device as seen')
        })
      }

      /**
       * The awaited stamp, for `hello` only: `online` in `GET /v1/devices` has
       * to be true by the time the device has finished saying hello, and a
       * fire-and-forget write could be read back before it landed.
       */
      const stampSeenNow = async (): Promise<void> => {
        lastTouchedAt = Date.now()
        try {
          await touchDevice(deviceId)
        } catch (error: unknown) {
          log.warn({ err: error, deviceId }, 'could not stamp the device as seen')
        }
      }

      /**
       * Writes `Device.state`. `updateMany` rather than `update`, so a device
       * row that vanished under a live socket cannot turn a message into a 500.
       */
      const writeDeviceState = async (state: DeviceState): Promise<void> => {
        deviceState = state
        try {
          await prisma.device.updateMany({ where: { id: deviceId }, data: { state } })
        } catch (error: unknown) {
          log.warn({ err: error, deviceId, state }, 'could not write Device.state')
        }
      }

      /* -- the state the live channel carries ------------------------------ */

      /**
       * `MediaStreamState`, filled from what this socket actually knows.
       *
       *   - `state`, `lastFrameAt`, `bytesIn`, `bytesOut`: **real**. The media
       *     state as the device reported it, the server clock at the last frame
       *     we took, and the bytes in each direction on this socket.
       *   - `audioLevel`: **real** — the RMS `services/frames.ts` computed from
       *     the last PCM chunk, which is what moves the app's meter.
       *   - `videoFps`: the device's own `telemetry.fps`, i.e. **device-reported
       *     rather than measured here**. 0 until it has told us.
       *   - `audioPlaying` and `speechQueueDepth`: **placeholders, and both
       *     constant.** Nothing in this row speaks: `audio.out` has no producer
       *     yet, so there is no line to be playing and no queue to be deep.
       *     `false` and `0` are the truthful values for "nothing is in flight",
       *     not fields someone forgot to wire up — whoever adds the speech path
       *     is the one who makes these numbers move.
       */
      const streamState = (): MediaStreamState => ({
        state: mediaState,
        videoFps: deviceFps,
        audioLevel,
        audioPlaying: false,
        speechQueueDepth: 0,
        lastFrameAt,
        bytesIn,
        bytesOut,
      })

      /**
       * Tells the session's live channel that the device's state changed, so the
       * desktop's tray can follow without polling. Published on the four
       * transitions that mean something — `state`, `media.start`, `media.stop`,
       * `media.state` — plus `session.open` for the initial value, and on
       * telemetry *while media is live* (that is when `videoFps` changes). Not
       * on every frame: 8 fps of `state` events would be a second live channel
       * with none of the value.
       *
       * Validated before publishing because `GET /v1/live/:sessionId` writes
       * `event.data` straight out; a NaN here would reach a client as malformed
       * JSON rather than as an error.
       */
      const publishState = (): void => {
        if (sessionId === null) return

        const event: LiveEvent = {
          event: 'state',
          data: { sessionId, deviceState, media: streamState() },
        }
        const validated = LiveEvent.safeParse(event)
        if (!validated.success) {
          log.error(
            { sessionId, issues: validated.error.issues },
            'built an invalid state event; publishing nothing',
          )
          return
        }
        publishLive(sessionId, validated.data)
      }

      /**
       * Releases everything this socket's session held in this process. With
       * `signals: true` it is the only caller of `endSignalSession` in the tree;
       * `endMediaSession` is called on both paths.
       *
       * The object store is deliberately untouched: stored frames outlive the
       * session, and `services/frames.ts` keeps the latest `ObjectRef` outside
       * the ring it clears here, so a still is still resolvable for a session
       * that just stopped streaming. The hub is ended with the media, which is
       * how a live subscriber learns the stream stopped instead of waiting on a
       * screen that will never update again.
       */
      const releaseSession = (reason: string, options: { signals: boolean }): void => {
        const ended = sessionId
        if (ended === null) return

        sessionId = null
        announced = null
        mediaState = 'idle'
        updateDevice(deviceId, socket, { sessionId: null })

        // The media ring belongs to this socket, so it always goes.
        endMediaSession(ended)

        // The signal ring deliberately does **not**. Those signals arrive from
        // the desktop over its own socket and describe the *session*, not this
        // connection, so dropping this socket -- a Pi whose Wi-Fi flaps, or a
        // cable someone kicks -- must not blank the live window for a session
        // that is still open. It is released only on an explicit
        // `session.close`, where the session row is closed in the same breath.
        if (options.signals) endSignalSession(ended)

        log.info(
          { deviceId, sessionId: ended, reason, signals: options.signals },
          'released the session state held by this socket',
        )
      }

      /* -- teardown -------------------------------------------------------- */

      /**
       * Everything a connection owns, released exactly once: the registry entry,
       * the heartbeat's interval **and** its deadline timer, the session's rings
       * and hub subscribers, and the device's state.
       *
       * `tornDown` rather than a flag that also blocks sends: after `terminate`
       * the `readyState` is no longer OPEN, so `send` and `ping` are already
       * no-ops, and a second call (an `error` followed by a `close`) must not
       * release the same session twice.
       */
      const teardown = async (code: number, reason: string): Promise<void> => {
        if (tornDown) return
        tornDown = true

        clearInterval(heartbeat)
        clearTimeout(dropTimer)
        dropTimer = undefined

        const removed = unregisterDevice(deviceId, socket)
        const ended = sessionId
        releaseSession(`socket closed (${code} ${reason})`, { signals: false })

        /**
         * A device with no socket is not watching anything, so the app must stop
         * saying it is. Marked here rather than only on a device-reported
         * transition: a Wi-Fi drop is the normal reason a socket goes away, and
         * the Pi never gets to say `idle`.
         *
         * Only when this socket was still the device's, though. A reconnect
         * replaces its predecessor and closes it, and the predecessor's `close`
         * arrives after the new connection is already live — writing `idle` (and
         * stamping `lastSeenAt`) from that tail would describe the dead
         * connection while the live one is saying hello. `unregisterDevice`
         * returning `false` is exactly "a newer socket owns this device now".
         */
        if (removed) {
          await writeDeviceState('idle')
          try {
            await touchDevice(deviceId)
          } catch (error: unknown) {
            log.warn({ err: error, deviceId }, 'could not stamp the device as seen on close')
          }
        } else {
          log.debug({ deviceId }, 'a newer connection owns this device; leaving its state alone')
        }

        log.info(
          {
            code,
            reason,
            deviceId,
            sessionId: ended,
            removedFromRegistry: removed,
            openMs: Date.now() - openedAt,
            bytesIn,
            bytesOut,
          },
          'device socket closed',
        )
      }

      /* -- text frames ----------------------------------------------------- */

      const handleText = async (text: string): Promise<void> => {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          pendingFrame = null
          sendError('unparseable_frame', 'A text frame must be JSON.')
          return
        }

        const parsed = DeviceToApi.safeParse(json)
        if (!parsed.success) {
          pendingFrame = null

          /**
           * `unknown_event` versus `invalid_frame`, decided by the contract
           * rather than by a list of event names kept in this file: a
           * discriminated union that fails on the discriminator itself reports
           * `invalid_union_discriminator`, so anything else is a known event with
           * a wrong shape. §11 names `unknown_event` as the code for a text frame
           * we do not know.
           */
          const ref = seqRef(json)
          if (parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator')) {
            sendError('unknown_event', 'That event is not part of the device contract.', ref)
            return
          }

          const issue = parsed.error.issues[0]
          const where = issue === undefined ? '' : issue.path.join('.')
          sendError(
            'invalid_frame',
            `Not a DeviceToApi message${where.length > 0 ? ` (${where})` : ''}: ${issue?.message ?? 'invalid'}`,
            ref,
          )
          return
        }

        const message = parsed.data

        /**
         * §5's rule, in one line: the raw JPEG follows a `frame` message
         * *immediately*. So a `frame` arms this and literally anything else
         * spends it, which is what stops a stale flag from accepting an unrelated
         * blob ten seconds later.
         */
        pendingFrame = message.t === 'frame' ? { seq: message.seq, ts: message.ts } : null

        switch (message.t) {
          case 'hello': {
            // The caps are not kept here: the registry holds them, which is where
            // anything that wants to push to this device will look for them.
            updateDevice(deviceId, socket, { caps: message.caps, agentVersion: message.agentVersion })

            /**
             * The frame carries a `deviceId`, and the credential already named
             * the device. The credential wins: a payload field must never be able
             * to re-point an authenticated socket at another device's row.
             */
            if (message.deviceId !== deviceId) {
              log.warn(
                { authenticated: deviceId, claimed: message.deviceId },
                'hello named a different device id; the authenticated one stands',
              )
            }

            await stampSeenNow()
            /**
             * `idle` on connect, not a guess about what the device is doing: the
             * state machine in §5 starts at `idle`, every transition is reported,
             * and a device that reconnects mid-session sends its own state a
             * moment later. What this prevents is the app showing `watching` for
             * a socket that has only just said hello — or for a previous
             * connection that never closed cleanly.
             */
            await writeDeviceState('idle')

            log.info(
              { deviceId, agentVersion: message.agentVersion, caps: message.caps },
              'device hello',
            )

            /**
             * **No acknowledgement, deliberately.** `ApiToDevice` has no ack
             * member — §3's "You receive" is `session.start`, `audio.out`,
             * `command`, `policy.update`, `error`, `session.stop` — so there is no
             * frame an ack could be, and inventing one would put something on the
             * wire the edge team has no reason to expect. Acceptance shows up as
             * the effects above plus the `session.start` below.
             */
            return
          }

          case 'session.open': {
            if (sessionId !== null) {
              sendError(
                'session_already_open',
                `This socket already has session ${sessionId} open; close it before opening another.`,
              )
              return
            }

            /**
             * Only *this socket's* session is checked, and the database is not
             * consulted: a `Session` row stays open until it is explicitly
             * closed, so refusing whenever an open row exists would make every
             * reconnect unable to start a session.
             */
            try {
              const { start } = await openSession({ goalId: message.goalId, deviceId })

              sessionId = start.sessionId
              updateDevice(deviceId, socket, { sessionId: start.sessionId })
              // `openSession` already bound the device to the session; saying it
              // again from the socket that owns the binding is free and keeps the
              // signal path and the registry pointing at the same session.
              bindSession(deviceId, start.sessionId)

              send(start)
              publishState()

              log.info(
                { deviceId, sessionId: start.sessionId, goalId: start.goal.id },
                'device opened a session',
              )
            } catch (error: unknown) {
              const status = statusCodeOf(error)
              sendError(
                status === 409
                  ? 'no_active_goal'
                  : status === 404
                    ? 'not_found'
                    : 'session_open_failed',
                clientMessageOf(error, 'The server could not open a session.'),
              )
            }
            return
          }

          case 'session.close': {
            const ended = sessionId
            if (ended === null) {
              log.debug({ deviceId }, 'session.close with no open session on this socket')
              return
            }

            try {
              await closeSession({ sessionId: ended, reason: message.reason })
            } catch (error: unknown) {
              log.warn({ err: error, deviceId, sessionId: ended }, 'could not close the session row')
              sendError('session_close_failed', 'The server could not close the session.')
            }

            // Whatever the row did, this process stops holding the session open.
            // `signals: true` because the session is over, not just this socket.
            releaseSession(`session.close: ${message.reason}`, { signals: true })
            await writeDeviceState('idle')
            return
          }

          case 'frame': {
            // The flag was armed above. Nothing is fetched or stored until the
            // JPEG that must follow it arrives.
            log.debug(
              { deviceId, sessionId, seq: message.seq, trigger: message.trigger },
              'expecting the raw JPEG for that trigger',
            )
            return
          }

          case 'media.start': {
            /**
             * Refused without a session, which §6 implies ("only while a session
             * wants them") and this row needs: media without a session would mean
             * an error per frame for a stream nothing can store. Saying so once,
             * at the start, is the answer that stops the spam.
             *
             * No reply on success: the contract requires none, and `media.start`
             * is not one of the six frames the device is told to expect back.
             */
            if (sessionId === null) {
              sendError('no_session', 'A media stream belongs to a session; open one first.')
              return
            }

            announced = { video: message.video, audio: message.audio }
            mediaState = 'live'
            publishState()

            log.info(
              { deviceId, sessionId, video: message.video, audio: message.audio },
              'device started media',
            )
            return
          }

          case 'media.stop': {
            // §6.4: tagged binary stops at once. Dropping the announced specs
            // too means a late chunk is refused rather than stored against a
            // stream the device has already declared over.
            announced = null
            mediaState = 'idle'
            publishState()

            log.info({ deviceId, sessionId, reason: message.reason }, 'device stopped media')
            return
          }

          case 'media.state': {
            mediaState = message.state
            publishState()
            log.debug({ deviceId, sessionId, state: message.state }, 'device media state')
            return
          }

          case 'state': {
            await writeDeviceState(message.state)
            publishState()
            log.debug({ deviceId, sessionId, state: message.state }, 'device state')
            return
          }

          case 'telemetry': {
            /**
             * Handled, and deliberately narrow: `fps` is used for the live
             * channel's `videoFps`, and the rest is logged. Telemetry is not
             * persisted — there is a `DeviceTelemetry` table and writing to it is
             * a decision for whoever builds the fleet view, not for the socket
             * that receives the frame.
             */
            deviceFps = message.fps
            if (mediaState === 'live') publishState()
            log.debug(
              {
                deviceId,
                sessionId,
                cpu: message.cpu,
                tempC: message.tempC,
                rssi: message.rssi,
                uptimeS: message.uptimeS,
                fps: message.fps,
                bytesSent: message.bytesSent,
              },
              'device telemetry',
            )
            return
          }

          case 'command.ack': {
            /**
             * Logged and dropped. Nothing in this row issues a command, so there
             * is no pending map for an ack to resolve; the moment something does —
             * the control row — this is where it lands. Not an error the device
             * sees, because acked commands are the device doing the right thing.
             */
            log.info(
              {
                deviceId,
                commandId: message.commandId,
                status: message.status,
                result: message.result,
              },
              'device acked a command',
            )
            return
          }

          case 'stream.info': {
            /**
             * Logged and dropped. The transport a device says it will serve for
             * `stream.start` belongs to the media row; nothing here consumes it,
             * and holding it in a variable nothing reads would be pretending
             * otherwise.
             */
            log.info(
              { deviceId, transport: message.transport, url: message.url },
              'device reported its stream transport',
            )
            return
          }

          case 'bargein': {
            /**
             * Logged and dropped: there is no speech playing to interrupt, since
             * nothing in this row produces `audio.out`. §6.3's "stop playback"
             * is the speech row's, and it will need this hook.
             */
            log.info({ deviceId, sessionId, ts: message.ts }, 'device reported a barge-in')
            return
          }
        }
      }

      /* -- binary frames --------------------------------------------------- */

      /**
       * Validates, stores and fans out one frame, from **either** binary path.
       *
       * `ref` is the `seq:17` an error quotes back, and it is passed in rather
       * than derived: only §5's trigger path has a device-assigned `seq`, so only
       * that path can be given a reference the device is able to act on. A tagged
       * media frame carries no `seq` at all and its server-assigned number is
       * meaningless to the Pi, so its errors go out without one instead of with a
       * number that looks like something the device sent.
       */
      const storeVideo = async (input: {
        bytes: Uint8Array
        seq: number
        ts?: string
        ref?: string
      }): Promise<void> => {
        if (sessionId === null) {
          sendError(
            'no_session',
            'A frame belongs to a session; the one that owns this socket is closed.',
            input.ref,
          )
          return
        }

        try {
          const meta = await ingestVideoFrame({
            sessionId,
            bytes: input.bytes,
            seq: input.seq,
            ...(input.ts === undefined ? {} : { ts: input.ts }),
          })
          // The server clock, not the device's `ts`: `lastFrameAt` answers "when
          // did we last see a frame", and a device with a wrong clock should not
          // be able to move it.
          lastFrameAt = new Date().toISOString()
          log.debug(
            { deviceId, sessionId, seq: meta.seq, bytes: meta.bytes, width: meta.width, height: meta.height },
            'stored a frame',
          )
        } catch (error: unknown) {
          if (error instanceof FrameRejectedError) {
            // The code travels on the error so this line never has to match an
            // English message — that is what `FrameRejectedError.code` is for.
            sendError(error.code, error.message, input.ref)
            return
          }
          throw error
        }
      }

      /** §5: the raw JPEG for the `frame` message that immediately preceded it. */
      const handleRawJpeg = async (
        bytes: Uint8Array,
        pending: { seq: number; ts: string } | null,
      ): Promise<void> => {
        if (pending === null) {
          sendError(
            'frame_without_event',
            'A raw JPEG must follow a `frame` message immediately; nothing preceded this one.',
          )
          return
        }
        await storeVideo({ bytes, seq: pending.seq, ts: pending.ts, ref: `seq:${pending.seq}` })
      }

      const handleBinary = async (bytes: Uint8Array): Promise<void> => {
        /**
         * The flag is spent by this message whatever the message turns out to be
         * — §5 is a statement about the *next* websocket message, and a tag that
         * arrives instead means the JPEG is not coming.
         */
        const pending = pendingFrame
        pendingFrame = null

        const first = bytes[0]
        const second = bytes[1]

        /**
         * The two paths, told apart by the first byte. A JPEG always starts
         * `0xFF 0xD8` and a tag is `0x01`/`0x02`/`0x03`, so there is no
         * ambiguity to resolve — and a Pi written to §5 (untagged trigger
         * frames) and a Pi written to §6 (tagged media) both work against this
         * one socket.
         */
        if (first === JPEG_SOI_0 && second === JPEG_SOI_1) {
          await handleRawJpeg(bytes, pending)
          return
        }

        if (first !== MEDIA_TAG.video && first !== MEDIA_TAG.audio && first !== MEDIA_TAG.meta) {
          sendError(
            'unknown_binary_tag',
            `A binary frame must start with a tag (0x01 video, 0x02 audio, 0x03 meta) or with a raw JPEG (0xFF 0xD8); this one starts with ${describeByte(first)}.`,
          )
          return
        }

        /** §11's `frame_without_media`: tagged binary before a `media.start`. */
        if (mediaState !== 'live' || announced === null) {
          sendError(
            'frame_without_media',
            'Tagged binary is only accepted while a `media.start` is in force.',
          )
          return
        }

        if (first === MEDIA_TAG.meta) {
          // §6's table: "`0x03` meta — reserved". Nothing to store, and silence
          // would look like success.
          sendError('media_tag_reserved', 'Tag 0x03 is reserved and carries nothing yet.')
          return
        }

        if (first === MEDIA_TAG.video) {
          /**
           * §6's video frames carry no `seq` — only §5's trigger path has one,
           * and it names the stored object. So the server numbers them, per
           * connection and monotonic, which is what keeps the object keys of one
           * session distinct.
           *
           * The tag byte is stripped before the bytes reach the JPEG walk.
           */
          mediaSeq += 1
          await storeVideo({ bytes: bytes.subarray(1), seq: mediaSeq })
          return
        }

        // Audio. The announced rate and channel count are what turn bytes into a
        // duration, and they are the reason `media.start` has to come first.
        if (sessionId === null) {
          sendError('no_session', 'Audio belongs to a session; the one that owns this socket is closed.')
          return
        }
        try {
          const meta = await ingestAudioChunk({
            sessionId,
            bytes: bytes.subarray(1),
            sampleRate: announced.audio.sampleRate,
            channels: announced.audio.channels,
          })
          audioLevel = meta.rms
          log.debug(
            { deviceId, sessionId, bytes: meta.bytes, durationMs: meta.durationMs, rms: meta.rms },
            'took an audio chunk',
          )
        } catch (error: unknown) {
          if (error instanceof FrameRejectedError) {
            sendError(error.code, error.message)
            return
          }
          throw error
        }
      }

      /* -- the heartbeat --------------------------------------------------- */

      /**
       * A deadline timer instead of a timestamp compared inside the interval:
       * the two things a long-lived server has to get right here are that a
       * socket which stops answering is dropped, and that neither timer outlives
       * the connection. The deadline is re-armed by anything the device says —
       * a message or a pong — so a healthy socket is never dropped and a dead
       * one goes within `DEAD_MS` of its last word.
       */
      let dropTimer: ReturnType<typeof setTimeout> | undefined

      const armDropTimer = (): void => {
        clearTimeout(dropTimer)
        if (tornDown) return
        dropTimer = setTimeout(() => {
          log.info(
            { deviceId, sessionId, silentMs: Date.now() - lastSeenAt },
            'device socket stopped answering; dropping it',
          )
          socket.terminate()
        }, DEAD_MS)
      }

      const heartbeat = setInterval(() => {
        if (tornDown || socket.readyState !== SOCKET_OPEN) return
        socket.ping()
      }, PING_MS)

      /**
       * Text and binary share one queue, in arrival order, and this is not only
       * about not interleaving work: §5's raw JPEG is defined by being the
       * *next* message, so the `frame` message that arms the flag must be handled
       * before the JPEG that consumes it even when the handler above is waiting
       * on a database write.
       */
      let queue: Promise<void> = Promise.resolve()

      const enqueue = (work: () => Promise<void>): void => {
        queue = queue.then(work).catch((error: unknown) => {
          log.error({ err: error, deviceId, sessionId }, 'failed to handle a device frame')
          sendError('internal_error', 'The server could not handle that frame.')
        })
      }

      socket.on('pong', () => {
        lastSeenAt = Date.now()
        armDropTimer()
        /**
         * A pong is the device telling us it is there, so it stamps the device
         * the same way a message does. Without this, a Pi whose only traffic is
         * the heartbeat would show as offline in the app while its socket is
         * provably alive and answering — the opposite of what
         * `routes/devices.ts#ONLINE_WINDOW_MS` says the heartbeat is for.
         */
        stampSeen()
      })

      socket.on('message', (raw: unknown, isBinary: boolean) => {
        lastSeenAt = Date.now()
        armDropTimer()
        stampSeen()

        if (isBinary) {
          const bytes = frameBytes(raw)
          bytesIn += bytes.byteLength
          enqueue(() => handleBinary(bytes))
          return
        }

        enqueue(() => handleText(frameText(raw)))
      })

      /**
       * A transport error closes the connection too, but not always with a
       * `close` event first, so teardown is called from both — it is idempotent.
       */
      socket.on('error', (error: unknown) => {
        log.warn({ err: error, deviceId, sessionId }, 'device socket errored')
        void teardown(1006, 'socket error').catch((failure: unknown) => {
          log.error({ err: failure, deviceId }, 'failed to tear down an errored device socket')
        })
      })

      socket.on('close', (code: number, reason: Buffer) => {
        void teardown(code, reason.toString()).catch((error: unknown) => {
          log.error({ err: error, deviceId }, 'failed to tear down a closed device socket')
        })
      })

      /* -- connected ------------------------------------------------------- */

      registerDevice({ deviceId, socket })
      armDropTimer()
      stampSeen()

      log.info(
        { deviceId, connections: connectionCount(), remote: request.ip },
        'device socket connected',
      )
    },
  )
}

export default device
