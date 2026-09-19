import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { GoalCreateRequest, GoalListResponse, GoalResponse, GoalUpdateRequest } from '@heli/contracts'
import type { GoalListResponse as GoalListBody, GoalResponse as GoalBody } from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { createGoal, deleteGoal, listGoals, updateGoal } from '../services/goal.js'

/**
 * The goal surface (§7): `POST` / `GET` / `PUT` / `DELETE` on `/v1/goals`.
 *
 * Every route is a thin wrapper. All of the coercion, the merging and the
 * refusal for a goal that still has sessions lives in `services/goal.ts`, which
 * is also what the desktop's settings screen reaches through these routes; a
 * second copy of any of it here would be a second answer to "what is a goal".
 *
 * All four are behind `requireUser`. A goal is the *user's* write (§8: "a
 * mutating endpoint that changes the goal or the policy is the user's, from the
 * desktop"), and the Pi's 90-day device token must not be able to rewrite what
 * the person is trying to do.
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
