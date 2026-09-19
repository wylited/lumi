import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import {
  CloseSessionRequest,
  OpenSessionRequest,
  OpenSessionResponse,
  Session,
  SessionDetailResponse,
  SessionListResponse,
  SignalWindowResponse,
} from '@heli/contracts'
import type {
  OpenSessionResponse as OpenSessionBody,
  Session as SessionBody,
  SessionDetailResponse as SessionDetailBody,
  SessionListResponse as SessionListBody,
  SignalWindow,
} from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { getWindow } from '../services/signals.js'
import { closeSession, getSessionDetail, listSessions, openSession, sessionExists } from '../services/session.js'

/**
 * The session surface (§7). One session is a stretch of a person, a desk and one
 * goal working together, and these five routes are how a client sees one begin,
 * end, and be read back.
 *
 * The shapes are the contract's, declared as response schemas so a drift is a
 * loud 500 here rather than a quiet fall back to demo data in both clients —
 * which is exactly what the desktop's `live.attach()` does with a bad answer,
 * and why an **open session must actually appear in `GET /v1/sessions`**: that
 * route is where the desktop looks for `endedAt === null` to decide what to
 * attach to.
 */

const SessionParams = z.object({ id: z.string().min(1) })

const sessions: FastifyPluginAsync = async (app) => {
  /**
   * Opens a session and answers `{ session, goal, policy }`.
   *
   * The service also builds the device's `session.start` frame from the same two
   * objects; the socket gets it by calling `openSession` itself (HELI-012), so
   * this route is the HTTP door to the one implementation.
   *
   * `goalId: null` is resolved to the active goal — the nullability §7 has in
   * `OpenSessionRequest` next to a `Session.goalId` the schema requires — which
   * is why the answer always carries a non-null `session.goalId`.
   */
  app.post(
    '/v1/sessions',
    {
      preHandler: requireUser,
      schema: {
        body: OpenSessionRequest,
        response: { 200: OpenSessionResponse, 201: OpenSessionResponse },
      },
    },
    async (request, reply): Promise<OpenSessionBody> => {
      const { session, goal, policy } = await openSession(request.body)
      void reply.code(201)
      return { session, goal, policy }
    },
  )

  /**
   * `POST /v1/sessions/:id/close`.
   *
   * **There is no `CloseSessionResponse` in `packages/contracts`**, so the
   * response here is the contract's `Session` — a local choice by this row, not
   * a shape the contract defines, and the one place in this file where the wire
   * shape is decided rather than read. Inventing a wrapper type in the server
   * would duplicate a contract shape, which AGENTS.md forbids outright; if a
   * client ever needs more than the session, the wrapper is a `contracts` commit
   * first.
   *
   * The body is optional **and nullable**, because that is literally what a
   * `POST` with no body arrives as: fastify hands the handler `null` for a
   * request with no `content-type` and no bytes, and `z.optional()` alone
   * rejects `null` with a 400 "Expected object, received null" for a call the
   * contract is happy to describe as `{ reason?: string }`. Both are the same
   * statement — no body, no reason — so both are accepted.
   */
  app.post(
    '/v1/sessions/:id/close',
    {
      preHandler: requireUser,
      schema: {
        params: SessionParams,
        body: CloseSessionRequest.nullable().optional(),
        response: { 200: Session },
      },
    },
    async (request): Promise<SessionBody> =>
      closeSession({ sessionId: request.params.id, reason: request.body?.reason }),
  )

  /** Every session, newest first. Open ones included; see the note at the top. */
  app.get(
    '/v1/sessions',
    {
      preHandler: requireUser,
      schema: { response: { 200: SessionListResponse } },
    },
    async (): Promise<SessionListBody> => listSessions(),
  )

  /** The session plus its goal, its observations and its interventions. */
  app.get(
    '/v1/sessions/:id',
    {
      preHandler: requireUser,
      schema: {
        params: SessionParams,
        response: { 200: SessionDetailResponse },
      },
    },
    async (request): Promise<SessionDetailBody> => {
      const detail = await getSessionDetail(request.params.id)
      /**
       * A 404, not an empty session and not a 500. Both merged clients handle
       * 404 by falling back to the fixtures — `apps/desktop/src/lib/api.ts`
       * parses with `SessionDetailResponse.nullable()` and the web's `read()`
       * returns the fixture session on a 404 — so the honest answer for an
       * unknown id is the one they already know how to take.
       */
      if (detail === null) {
        throw Object.assign(new Error(`No session ${request.params.id}.`), { statusCode: 404 })
      }
      return detail
    },
  )

  /**
   * The latest `SignalWindow` for a session, or `null`.
   *
   * This is the route HELI-015 could not verify its own `Done when` with: the
   * phase doc asks the signal row to expose the window, but the file belongs to
   * this one. `apps/desktop/src/lib/api.ts#window()` already calls it and parses
   * with `SignalWindowResponse.nullable()`, so the schema is nullable and the
   * answer for a session that has produced no signals *in this process* is
   * `null` — not a 404, and not a window of zeros, which would claim a session
   * of silence lasted a minute.
   *
   * The existence check is here, and nowhere else in this file, so that an id
   * nobody has ever heard of is answered 404 like every other `/sessions/:id`
   * route, while a real session with no foldable signals is answered `null`.
   * The two are different statements and `GET /v1/sessions/:id` already
   * distinguishes them.
   */
  app.get(
    '/v1/sessions/:id/window',
    {
      preHandler: requireUser,
      schema: {
        params: SessionParams,
        response: { 200: SignalWindowResponse.nullable() },
      },
    },
    async (request): Promise<SignalWindow | null> => {
      if (!(await sessionExists(request.params.id))) {
        throw Object.assign(new Error(`No session ${request.params.id}.`), { statusCode: 404 })
      }
      return getWindow(request.params.id)
    },
  )
}

export default sessions
