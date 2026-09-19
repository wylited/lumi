import type { FastifyPluginAsync } from 'fastify'

import { requireUser } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import {
  FrameRejectedError,
  MAX_FRAME_BYTES,
  countFrames,
  getFrame,
  ingestVideoFrame,
  latestFrameRef,
} from '../services/frames.js'

/**
 * The rig's HTTP surface. This replaces the retired device socket: the Mac
 * uploads the newest frame, the server attributes it to the one open session,
 * and the frame the model assessed can be read back.
 *
 * Single user, single desk. The rig never handles a user id or a session id —
 * it posts a frame and the server decides whose night it belongs to.
 */
export const prefix = '/v1'

const capturedAt = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const deskRoutes: FastifyPluginAsync = async (app) => {
  // Raw JPEG bodies, scoped to this plugin. A frame is not multipart and not
  // JSON; it is the bytes and nothing else.
  app.addContentTypeParser(
    ['image/jpeg', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_FRAME_BYTES + 64 * 1024 },
    (_request, body, done) => {
      done(null, body)
    },
  )

  /** The desk, the one open session, and whether frames are arriving. */
  app.get('/desk', { preHandler: requireUser }, async () => {
    const [desk, session] = await Promise.all([
      prisma.device.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.session.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } }),
    ])
    const ref = session ? latestFrameRef(session.id) : null
    return {
      desk: desk ? { id: desk.id, name: desk.name, state: desk.state } : null,
      session: session
        ? { id: session.id, goalId: session.goalId, startedAt: session.startedAt.toISOString() }
        : null,
      frames: session ? countFrames(session.id) : 0,
      hasFrame: ref !== null,
    }
  })

  /**
   * `POST /v1/desk/frames` — the newest frame, as raw JPEG bytes.
   *
   * There is exactly one open session and it is the user's, so the frame is
   * attributed to it rather than the rig naming a session it has no business
   * knowing about.
   */
  app.post('/desk/frames', { preHandler: requireUser }, async (request, reply) => {
    const session = await prisma.session.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: 'desc' },
    })
    if (!session) {
      return reply.code(409).send({
        error: 'no_open_session',
        message: 'Nothing is being watched right now, so there is nobody to attribute this to.',
      })
    }

    const body: unknown = request.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({
        error: 'empty_frame',
        message: 'Send the JPEG bytes as the request body.',
      })
    }

    try {
      const meta = await ingestVideoFrame({
        sessionId: session.id,
        bytes: body,
        seq: countFrames(session.id) + 1,
        ...(() => {
          const ts = capturedAt(request.headers['x-heli-captured-at'])
          return ts === undefined ? {} : { ts }
        })(),
      })
      return reply.code(201).send({ ...meta, sessionId: session.id })
    } catch (error) {
      if (error instanceof FrameRejectedError) {
        // A rejected frame is a client bug, not a server fault: name the reason
        // and store nothing.
        return reply.code(422).send({
          error: 'frame_rejected',
          code: error.code,
          message: error.message,
        })
      }
      throw error
    }
  })

  /** The frame the last assessment actually looked at. */
  app.get('/sessions/:id/frame.jpg', { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const ref = latestFrameRef(id)
    if (ref === null) return reply.code(204).send()
    const bytes = await getFrame(ref)
    if (bytes === null) return reply.code(204).send()
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=5')
      .send(Buffer.from(bytes))
  })
}

export default deskRoutes
