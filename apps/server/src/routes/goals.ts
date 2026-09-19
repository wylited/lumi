import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import {
  GoalCreateRequest,
  GoalDraft,
  GoalDraftRequest,
  GoalListResponse,
  GoalResponse,
  GoalUpdateRequest,
} from '@heli/contracts'
import type {
  GoalDraft as GoalDraftBody,
  GoalListResponse as GoalListBody,
  GoalResponse as GoalBody,
} from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { draftGoal } from '../services/goal-draft.js'
import { createGoal, deleteGoal, listGoals, updateGoal } from '../services/goal.js'

/**
 * The goal surface (§7): `POST` / `GET` / `PUT` / `DELETE` on `/v1/goals`, plus
 * the drafting step the setup screen opens with (`POST /v1/goals/draft`).
 *
 * Every route is a thin wrapper. All of the coercion, the merging and the
 * refusal for a goal that still has sessions lives in `services/goal.ts`, which
 * is also what the desktop's settings screen reaches through these routes; a
 * second copy of any of it here would be a second answer to "what is a goal".
 * Drafting is the same discipline: the model-or-local decision is
 * `services/goal-draft.ts`'s, and this file only declares the contract.
 *
 * All of them are behind `requireUser`. A goal is the *user's* write (§8: "a
 * mutating endpoint that changes the goal or the policy is the user's, from the
 * desktop"), and the Pi's 90-day device token must not be able to rewrite what
 * the person is trying to do. Drafting is behind it too: the route spends the
 * server's model key, which is not a device's to spend.
 */

const GoalParams = z.object({ id: z.string().min(1) })

const goals: FastifyPluginAsync = async (app) => {
  /** Every goal, active first. `GoalListResponse` is an array, as the contract says. */
  app.get(
    '/v1/goals',
    {
      preHandler: requireUser,
      schema: { response: { 200: GoalListResponse } },
    },
    async (): Promise<GoalListBody> => listGoals(),
  )

  /**
   * `GoalCreateRequest` is `Goal` minus `id`/`createdAt`, with `policy`
   * optional — so a goal created without a policy gets `DEFAULT_POLICY` from
   * `@heli/contracts`, in the service, rather than a policy-shaped hole.
   *
   * 201 and a copy of the created goal, declared for 200 as well: the two
   * merged clients accept any 2xx and parse the body, and declaring both
   * statuses keeps the response validated by the contract's own schema whichever
   * one is sent.
   */
  app.post(
    '/v1/goals',
    {
      preHandler: requireUser,
      schema: {
        body: GoalCreateRequest,
        response: { 200: GoalResponse, 201: GoalResponse },
      },
    },
    async (request, reply): Promise<GoalBody> => {
      const goal = await createGoal(request.body)
      void reply.code(201)
      return goal
    },
  )

  /**
   * Drafting: a sentence in, a goal to accept in.
   *
   * It is a `POST` on a `goals` path but it is not a write: nothing is persisted
   * and no row is created, which is the point — the person edits the draft on
   * the setup screen and only then posts it to `POST /v1/goals`. The route is
   * therefore the same shape as its siblings and nothing more: the sentence is
   * validated here (`GoalDraftRequest`, `.strict()`, 1 to 500 characters, so an
   * empty, oversized or extra-keyed body is a 400 rather than a 500), the model-or-local
   * decision lives in `services/goal-draft.ts`, and the answer is held to
   * `GoalDraft` by the response serializer.
   *
   * The answer is a complete goal. Every field `GoalCreateRequest` needs is in
   * it, so the draft posts to `POST /v1/goals` unchanged — except `source`, the
   * one key that says which path drafted it and the one key that endpoint does
   * not accept. A client posts `GoalCreateRequest.parse(draft)`.
   *
   * It never answers 500 for a bad suggestion. A draft is a suggestion; refusing
   * to suggest is worse than suggesting plainly.
   */
  app.post(
    '/v1/goals/draft',
    {
      preHandler: requireUser,
      schema: {
        body: GoalDraftRequest,
        response: { 200: GoalDraft },
      },
    },
    async (request): Promise<GoalDraftBody> => draftGoal(request.body.sentence),
  )

  /**
   * A merge, not a replace — see `services/goal.ts#updateGoal` for why, and for
   * why `null` and an absent key mean different things. `GoalUpdateRequest` is
   * `GoalCreateRequest.partial()`, so a patch may name one field or twelve.
   */
  app.put(
    '/v1/goals/:id',
    {
      preHandler: requireUser,
      schema: {
        params: GoalParams,
        body: GoalUpdateRequest,
        response: { 200: GoalResponse },
      },
    },
    async (request): Promise<GoalBody> => updateGoal(request.params.id, request.body),
  )

  /**
   * Deletes a goal that nothing depends on. A goal that still has sessions is
   * refused with a 409 that names the reason and the count — the foreign key
   * would otherwise make this a `P2003`, i.e. a 500 reading "Internal server
   * error", and it would take the sessions' observations with it if it cascaded.
   *
   * The deleted goal comes back. §7 lists `Goal` as what delete returns, and the
   * caller that just removed a row has something honest to show for it.
   */
  app.delete(
    '/v1/goals/:id',
    {
      preHandler: requireUser,
      schema: {
        params: GoalParams,
        response: { 200: GoalResponse },
      },
    },
    async (request): Promise<GoalBody> => deleteGoal(request.params.id),
  )
}

export default goals
