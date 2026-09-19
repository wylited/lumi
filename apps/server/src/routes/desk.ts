import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { DeskFrameResponse, DeskStatus, FrameRejectionCode } from '@heli/contracts'
import {
  Desk,
  DeskActionRecord,
  DeskActionRequest,
  DeskRegistration,
  DeskRegisterResponse,
} from '@heli/contracts'
import type {
  DeskFrameResponse as DeskFrameBody,
  DeskRegisterResponse as DeskRegisterBody,
  DeskStatus as DeskStatusBody,
} from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import {
  buildAction,
  deskHealthOf,
  deskRowExists,
  getTheDesk,
  isDeskConnected,
  issueAction,
  listActions,
  registerDesk,
} from '../services/desk.js'
import { sessionExists } from '../services/session.js'
import {
  FRAME_SOURCES,
  FrameRejectedError,
  framesAccepted,
  getFrame,
  ingestVideoFrame,
  isFrameSource,
  resolveLatestFrameRef,
} from '../services/frames.js'
import type { FrameSource } from '../services/frames.js'

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
/** The server's own envelope, which is `{ error }` and nothing more. */
const NotFound = z.object({ error: z.string() })

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

/**
 * `x-heli-source` on the way in, `?source=` on the way out.
 *
 * Absent means the camera, because the rig does not send the header at all — it
 * has one lens. An unknown value is **refused** rather than folded into the
 * default: a typo'd source that quietly became `camera` would drop a screenshot
 * into the desk pane and nothing would ever say so, which is the same class of
 * bug this row exists to fix. The rejected value is deliberately not echoed.
 */
const frameSourceOf = (value: unknown): FrameSource | null => {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === '') return 'camera'
  return isFrameSource(raw) ? raw : null
}

const sourceRefusal = (): { error: string; message: string } => ({
  error: 'unknown_source',
  message: `x-heli-source and ?source= must be one of: ${FRAME_SOURCES.join(', ')}.`,
})

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
        getTheDesk(),
        prisma.session.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } }),
      ])
      // Resolved from the store, not the in-memory mirror: after a restart the
      // mirror is empty but the rig's frame is still in the bucket, and a panel
      // that reported `hasFrame: false` then would be lying about its own store.
      const ref = session ? await resolveLatestFrameRef(session.id) : null

      return {
        desk,
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
        // These two come alive with the desk socket: they now say whether a rig
        // has actually handshaked, which is what the panel's disconnected state
        // means. Before 044, `false`/`null` was the honest answer.
        connected: desk !== null && isDeskConnected(desk.id),
        health: desk === null ? null : deskHealthOf(desk.id),
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
          400: DeskRefusal,
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

      const source = frameSourceOf(request.headers['x-heli-source'])
      if (source === null) return reply.code(400).send(sourceRefusal())

      try {
        const meta = await ingestVideoFrame({
          sessionId: session.id,
          bytes: body,
          source,
          seq: rigSeq(request.headers['x-heli-seq']) ?? framesAccepted(session.id) + 1,
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
      schema: {
        params: z.object({ id: z.string().min(1) }),
        querystring: z.object({ source: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params
      if (!(await sessionExists(id))) return reply.code(404).send({ error: `No session ${id}.` })

      const source = frameSourceOf(request.query.source)
      if (source === null) return reply.code(400).send(sourceRefusal())

      // Resolved from the store rather than the mirror, for the same reason
      // `GET /v1/desk` does: the preview must survive a server restart. Per
      // source, because the desk pane and the screen pane are asking for two
      // different pictures of the same moment.
      const ref = await resolveLatestFrameRef(id, source)
      if (ref === null) return reply.code(204).header('cache-control', 'no-store').send()

      const bytes = await getFrame(ref)
      if (bytes === null) return reply.code(204).header('cache-control', 'no-store').send()

      return reply
        .header('content-type', 'image/jpeg')
        // A stable key per source, so the still is short-lived by design: 5 s
        // keeps a 2 fps preview from re-fetching on every paint, and is short
        // enough that a new frame shows up.
        .header('cache-control', 'private, max-age=5')
        .send(Buffer.from(bytes))
    },
  )

  /* ---- registration, and the action log ---------------------------------- */

  /**
   * `POST /v1/desks` — registration replaces pairing.
   *
   * The setup UI posts the desk's name, its camera and (optionally) its arm, and
   * gets back a **desk token**: the rig is a headless process and must never hold
   * the person's credentials. Idempotent on the id the rig stores locally, so
   * re-running setup updates the desk instead of creating a second one, and the
   * token is reissued so a lost one can be recovered by re-running setup.
   */
  app.post(
    '/desks',
    {
      preHandler: requireUser,
      schema: { body: DeskRegistration, response: { 200: DeskRegisterResponse } },
    },
    async (request): Promise<DeskRegisterBody> => registerDesk(request.body),
  )

  /**
   * `GET /v1/desks` — the one desk.
   *
   * There is no `DeskListResponse` in `@heli/contracts` (a gap this row cannot
   * close, since contracts are not in its `Touches`), so the array is composed
   * from the contract's own `Desk` rather than a hand-written shape.
   */
  app.get(
    '/desks',
    { preHandler: requireUser, schema: { response: { 200: z.array(Desk) } } },
    async () => {
      const desk = await getTheDesk()
      return desk === null ? [] : [desk]
    },
  )

  /**
   * `POST /v1/desks/:id/actions` — a manual action.
   *
   * Answers `200` with the record, **including when the action failed**: "I
   * pressed it and nothing happened" is the one outcome the panel must never
   * produce, so a missing rig comes back as a record with `failed` and
   * `desk_offline` rather than as an HTTP error the caller might swallow.
   */
  app.post(
    '/desks/:id/actions',
    {
      preHandler: requireUser,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        body: DeskActionRequest,
        response: { 200: DeskActionRecord, 404: NotFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      if (!(await deskRowExists(id))) return reply.code(404).send({ error: `No desk ${id}.` })

      // `buildAction` parses against the contract's own union, so an unknown type
      // or a payload the contract forbids is a 400 here rather than a frame the
      // rig cannot understand.
      return issueAction(id, buildAction(request.body))
    },
  )

  /** `GET /v1/desks/:id/actions` — the log, newest first. */
  app.get(
    '/desks/:id/actions',
    {
      preHandler: requireUser,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.array(DeskActionRecord), 404: NotFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      if (!(await deskRowExists(id))) return reply.code(404).send({ error: `No desk ${id}.` })
      return listActions(id)
    },
  )
}

export default deskRoutes
