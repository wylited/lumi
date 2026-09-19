import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { ApiToMobile, HELI_SOCKET_PROTOCOL, MobileToApi } from '@heli/contracts'
import type { ApiToMobile as ApiToMobileMessage } from '@heli/contracts'

import { verifyMobileToken } from '../lib/jwt.js'
import { childLogger } from '../logger.js'
import { ingestSignals } from '../services/signals.js'
import { applyPhoneSignals, notePhoneHello, openSessionId } from '../services/mobile.js'
import { attachMobileSocket, detachMobileSocket, type LiveMobileSocket } from './live-mobile.js'

const log = childLogger({ module: 'ws.mobile' })

/**
 * `ws://api/ws/mobile` — the phone's live transport.
 *
 * The phone is a surface, not a controller: it sends what it can see (app usage
 * and unlocks on Android, motion everywhere, its own screen state) and it
 * receives what the loop decided — a nudge, or a spoken line as an `audio.out`
 * header followed by one tagged PCM frame. It is never told which session to
 * trust: the server resolves the open session, exactly as it does for the rig's
 * frames, so a phone in a pocket cannot point the observer at somebody else's
 * night.
 *
 * Auth is the paired phone token (`typ: mobile`), read from the subprotocol or
 * the query for the same reason the desktop's is: a webview and a React Native
 * `WebSocket` can set a protocol, not a header.
 */

const PING_MS = 20_000
const DEAD_MS = 60_000

const SOCKET_OPEN = 1

const unauthorized = (message: string): Error =>
  Object.assign(new Error(message), { statusCode: 401 })

const MobileQuery = z.object({ token: z.string().min(1).optional() })

const splitProtocols = (header: string | undefined): string[] =>
  (header ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const tokenFromProtocols = (protocols: readonly string[]): string | null => {
  const index = protocols.indexOf(HELI_SOCKET_PROTOCOL)
  if (index === -1) return null
  const token = protocols[index + 1]
  return token !== undefined && token.length > 0 ? token : null
}

const frameText = (raw: unknown): string => {
  if (typeof raw === 'string') return raw
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return String(raw)
}

const mobile: FastifyPluginAsync = async (app) => {
  let connections = 0

  app.get(
    '/ws/mobile',
    {
      websocket: true,
      schema: { querystring: MobileQuery },
      logLevel: 'warn',
      onRequest: async (request) => {
        const token =
          tokenFromProtocols(splitProtocols(request.headers['sec-websocket-protocol'])) ??
          request.query.token ??
          null

        if (token === null) {
          throw unauthorized(
            `A phone token is required: Sec-WebSocket-Protocol: ${HELI_SOCKET_PROTOCOL}, <token>`,
          )
        }
        request.phoneId = verifyMobileToken(token)
      },
    },
    (socket, request) => {
      connections += 1
      const phoneId = request.phoneId ?? 'unknown'
      const openedAt = Date.now()
      let lastSeenAt = openedAt
      let sessionId: string | null = null
      let attachedSession: string | null = null
      let playback: { playing: boolean; momentId: string | null } | null = null
      let closing = false

      const sendFrame = (message: ApiToMobileMessage): boolean => {
        if (closing || socket.readyState !== SOCKET_OPEN) return false
        const validated = ApiToMobile.safeParse(message)
        if (!validated.success) {
          log.error({ issues: validated.error.issues }, 'refused to send an invalid phone frame')
          return false
        }
        socket.send(JSON.stringify(validated.data))
        return true
      }

      const send = (message: ApiToMobileMessage): void => {
        sendFrame(message)
      }

      const sendError = (code: string, message: string): void => {
        send({ t: 'error', code, message })
      }

      const outbound: LiveMobileSocket = {
        send: sendFrame,
        sendBinary: (bytes) => {
          if (closing || socket.readyState !== SOCKET_OPEN) return false
          socket.send(bytes)
          return true
        },
      }

      const watch = (next: string | null): void => {
        if (next === attachedSession) return
        if (attachedSession !== null) detachMobileSocket(attachedSession, outbound)
        attachedSession = next
        if (next !== null) attachMobileSocket(next, outbound)
      }

      log.info({ phoneId, connections }, 'phone socket connected')

      socket.on('pong', () => {
        lastSeenAt = Date.now()
      })

      const heartbeat = setInterval(() => {
        if (closing) return
        if (Date.now() - lastSeenAt > DEAD_MS) {
          log.info({ phoneId, sessionId }, 'phone socket silent for 60s; dropping it')
          closing = true
          clearInterval(heartbeat)
          socket.terminate()
          return
        }
        socket.ping()
      }, PING_MS)

      let queue: Promise<void> = Promise.resolve()

      const handle = async (text: string): Promise<void> => {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          sendError('unparseable_frame', 'A text frame must be JSON.')
          return
        }

        const parsed = MobileToApi.safeParse(json)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const where = issue ? issue.path.join('.') : ''
          sendError(
            'invalid_frame',
            `Not a MobileToApi message${where.length > 0 ? ` (${where})` : ''}: ${issue?.message ?? 'invalid'}`,
          )
          return
        }

        switch (parsed.data.t) {
          case 'hello': {
            notePhoneHello(phoneId, {
              name: parsed.data.name,
              platform: parsed.data.platform,
              appVersion: parsed.data.appVersion,
            })

            // The phone's belief is checked, not trusted: the server's open
            // session is the answer, and a disagreement is worth a log line.
            const open = await openSessionId()
            if (parsed.data.sessionId !== null && parsed.data.sessionId !== open) {
              log.warn(
                { phoneId, claimed: parsed.data.sessionId, open },
                'phone named a session that is not the open one; using the open one',
              )
            }
            sessionId = open
            watch(sessionId)

            log.info({ phoneId, platform: parsed.data.platform, sessionId }, 'phone hello')
            send({ t: 'ack', accepted: 0 })
            return
          }

          case 'signals': {
            const batch = parsed.data
            if (sessionId === null) {
              sessionId = await openSessionId()
              watch(sessionId)
            }

            applyPhoneSignals(phoneId, batch.signals, sessionId)
            const { accepted } = await ingestSignals(phoneId, sessionId, batch.signals)
            send({ t: 'ack', accepted })
            return
          }

          case 'playback': {
            playback = { playing: parsed.data.playing, momentId: parsed.data.momentId }
            log.debug({ phoneId, ...playback }, 'phone playback state recorded')
            return
          }
        }
      }

      socket.on('message', (raw: unknown, isBinary: boolean) => {
        lastSeenAt = Date.now()

        if (isBinary) {
          // Audio travels server → phone only; a phone uploading samples has
          // nothing this server asked for.
          sendError('binary_not_supported', 'The phone socket carries JSON text frames only.')
          return
        }

        queue = queue
          .then(() => handle(frameText(raw)))
          .catch((error: unknown) => {
            log.error({ err: error, phoneId, sessionId }, 'failed to handle a phone frame')
            sendError('internal_error', 'The server could not handle that frame.')
          })
      })

      socket.on('close', (code: number, reason: Buffer) => {
        closing = true
        if (attachedSession !== null) detachMobileSocket(attachedSession, outbound)
        attachedSession = null
        clearInterval(heartbeat)
        connections -= 1
        log.info(
          {
            code,
            reason: reason.toString(),
            phoneId,
            sessionId,
            connections,
            openMs: Date.now() - openedAt,
          },
          'phone socket closed',
        )
        playback = null
      })
    },
  )
}

export default mobile
