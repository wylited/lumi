import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { DeskFrameResponse, DeskStatus, FrameRejectionCode } from '@heli/contracts'
import type {
  Desk as DeskContract,
  DeskFrameResponse as DeskFrameBody,
  DeskStatus as DeskStatusBody,
} from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { sessionExists } from '../services/session.js'
import {
  FrameRejectedError,
  framesAccepted,
  getFrame,
  ingestVideoFrame,
  resolveLatestFrameRef,
} from '../services/frames.js'

/**
 * The rig's HTTP surface. This replaces the retired device socket: the Mac
 * uploads its newest frame, the server attributes it to the one open session, and
 * the frame the model assessed can be read back.
 *
 * Single user, single desk. The rig never handles a user id or a session id — it
 * posts a frame, and the server decides whose night it belongs to.
 *
 * Both read routes declare their `@heli/contracts` schema as a `response`, which
 * is not decoration. Without one, a body that drifts from `DeskFrameResponse` or
 * `DeskStatus` still answers `200`, and the rig — which parses these shapes out of
 * `dist/json-schema.json` — fails somewhere far away from the cause. With them,
 * drift is a 500 here, at the writing end.
 */
export const prefix = '/v1'

/**
 * The refusal shapes, declared so they are validated on the way out like every
 * other response here. They are not contracts — a refusal is this route's own
 * HTTP business, the same way `plugins/errors.ts` owns the generic envelope — but
 * the *code* inside one is, so `FrameRejectionCode` comes from the contract the
 * rig reads rather than a second copy of the same three strings.
 */
const DeskRefusal = z.object({ error: z.string(), message: z.string() })
const FrameRefused = z.object({
  error: z.literal('frame_rejected'),
  code: FrameRejectionCode,
  message: z.string(),
})

const capturedAt = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * The rig's own monotonic counter, when it sends one. It is a header rather than
 * a body field because the body is the JPEG and nothing else. Anything that is
 * not a non-negative integer is ignored rather than coerced, so a broken rig
 * cannot make two frames collide on one object key.
 */
const rigSeq = (value: unknown): number | null => {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * A `Device` row as the contract's `Desk`.
 *
 * `camera` and `arm` are null until HELI-044 gives the desk a row of its own to
 * hold them, because the rig reports its caps over `/ws/desk`, which does not
 * exist yet. `state` is deliberately dropped: `Desk` has no field for it, and a
 * desk's state is now whether it is connected, which `DeskStatus.connected` says.
 */
const toApiDesk = (row: {
  id: string
  name: string
  createdAt: Date
  lastSeenAt: Date | null
}): DeskContract => ({
  id: row.id,
  name: row.name,
  camera: null,
  arm: null,
  registeredAt: row.createdAt.toISOString(),
  lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
})

/**
 * The parser's ceiling, deliberately **above** the frame cap.
 *
 * If this were set to `MAX_FRAME_BYTES`, an oversized frame would be stopped by
 * Fastify while it was still reading, and the rig would get Fastify's generic
 * `413 {"error":"Request body is too large"}` instead of the `frame_too_large`
 * code it branches on. Four times the cap gives `ingestVideoFrame` room to answer
 * with the contract's own code for every realistically-oversized frame, while the
 * limit still refuses to buffer anything unbounded -- past 8 MB Fastify stops the
 * read before a byte reaches this process's memory.
 */
const FRAME_BODY_LIMIT = 8 * 1024 * 1024

const deskRoutes: FastifyPluginAsync = async (app) => {
  // Raw JPEG bodies, scoped to this plugin. A frame is not multipart and not
  // JSON; it is the bytes and nothing else.
  app.addContentTypeParser(
    ['image/jpeg', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: FRAME_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body)
    },
  )

  /** The desk, the one open session, and whether frames are arriving. */
  app.get(
    '/desk',
    { preHandler: requireUser, schema: { response: { 200: DeskStatus } } },
    async (): Promise<DeskStatusBody> => {
      const [desk, session] = await Promise.all([
        prisma.device.findFirst({ orderBy: { createdAt: 'asc' } }),
        prisma.session.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } }),
      ])
      // Resolved from the store, not the in-memory mirror: after a restart the
      // mirror is empty but the rig's frame is still in the bucket, and a panel
      // that reported `hasFrame: false` then would be lying about its own store.
      const ref = session ? await resolveLatestFrameRef(session.id) : null

      return {
        desk: desk ? toApiDesk(desk) : null,
        session: session
          ? {
              id: session.id,
              // Required in Prisma, nullable in `OpenSessionRequest`; a session
              // always has a goal, so this is never null in practice.
              goalId: session.goalId,
              startedAt: session.startedAt.toISOString(),
            }
          : null,
        // How many frames the rig has landed, not how many we hold: the desk path
        // retains only the newest, so a ring length would sit at 1 forever and
        // the panel would never look alive.
        frames: session ? framesAccepted(session.id) : 0,
        hasFrame: ref !== null,
        // The desk socket arrives in HELI-044. `false` is the honest answer
        // today, and it is what stops a panel claiming a rig is connected when
        // nothing has ever handshaken.
        connected: false,
        health: null,
      }
    },
  )

  /**
   * `POST /v1/desk/frames` — the newest frame, as raw JPEG bytes.
   *
   * There is exactly one open session and it is the user's, so the frame is
   * attributed to it rather than the rig naming a session it has no business
   * knowing about.
   *
   * `retain: 'newest'` is the row's point: at the rig's ~2 fps a ring of stale
   * stills is memory and storage nobody will read, and a stale frame is worse
   * than a missing one.
   */
  app.post(
    '/desk/frames',
    {
      preHandler: requireUser,
      schema: {
        response: {
          201: DeskFrameResponse,
          409: DeskRefusal,
          422: FrameRefused,
        },
      },
    },
    async (request, reply): Promise<DeskFrameBody | undefined> => {
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
      if (!Buffer.isBuffer(body)) {
        // Reachable when a client sends a content-type the JPEG parser does not
        // handle, so the body arrived parsed as something else. "You did not send
        // JPEG bytes" is what `frame_not_jpeg` means, and answering with the
        // contract's own code keeps the rig to three branches instead of four.
        return reply.code(422).send({
          error: 'frame_rejected',
          code: 'frame_not_jpeg',
          message: 'Send the JPEG bytes as the request body.',
        })
      }

      try {
        const meta = await ingestVideoFrame({
          sessionId: session.id,
          bytes: body,
          seq: rigSeq(request.headers['x-heli-seq']) ?? framesAccepted(session.id) + 1,
          retain: 'newest',
          ...(() => {
            const ts = capturedAt(request.headers['x-heli-captured-at'])
            return ts === undefined ? {} : { ts }
          })(),
        })

        // Exactly `DeskFrameResponse`, which is `.strict()`: `ref` is the object
        // key as a string, and `ts` and `bytes` stay server-side.
        return reply.code(201).send({
          sessionId: session.id,
          ref: meta.ref.key,
          seq: meta.seq,
          width: meta.width,
          height: meta.height,
        })
      } catch (error) {
        if (error instanceof FrameRejectedError) {
          // A rejected frame is a client bug, not a server fault: name the code
          // the rig branches on, and store nothing at all.
          return reply.code(422).send({
            error: 'frame_rejected',
            code: error.code,
            message: error.message,
          })
        }
        throw error
      }
    },
  )

  /**
   * The frame the last assessment actually looked at, as a still the desktop's
   * preview can point an `<img>` at.
   *
   * The two empty cases are deliberately different, which the rig contract does
   * not say and this row had to decide:
   *   - an **unknown session** is a 404, like every other `/sessions/:id` route;
   *   - a real session with **no frame yet** is a 204.
   * Collapsing them into one 204 would make a typo'd id look like "not yet", and
   * 204 is cacheable by default, so both empty answers say `no-store` — otherwise
   * a browser is free to remember "no frame" and show a broken preview long after
   * one arrived.
   */
  app.get(
    '/sessions/:id/frame.jpg',
    {
      preHandler: requireUser,
      schema: { params: z.object({ id: z.string().min(1) }) },
    },
    async (request, reply) => {
      const { id } = request.params
      if (!(await sessionExists(id))) return reply.code(404).send({ error: `No session ${id}.` })

      // Resolved from the store rather than the mirror, for the same reason
      // `GET /v1/desk` does: the preview must survive a server restart.
      const ref = await resolveLatestFrameRef(id)
      if (ref === null) return reply.code(204).header('cache-control', 'no-store').send()

      const bytes = await getFrame(ref)
      if (bytes === null) return reply.code(204).header('cache-control', 'no-store').send()

      return reply
        .header('content-type', 'image/jpeg')
        // One stable key per session on the desk path, so the still is
        // short-lived by design: 5 s keeps a 2 fps preview from re-fetching on
        // every paint, and is short enough that a new frame shows up.
        .header('cache-control', 'private, max-age=5')
        .send(Buffer.from(bytes))
    },
  )
}

export default deskRoutes
