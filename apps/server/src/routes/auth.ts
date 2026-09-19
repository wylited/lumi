import type { FastifyPluginAsync } from 'fastify'

import { DevLoginRequest, DevLoginResponse } from '@heli/contracts'
import type { User } from '@heli/contracts'

import { signUserToken } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

/**
 * The DB row is older and looser than the contract: `name` is nullable in
 * Prisma and a required string in `User`, `createdAt` is a Date and the contract
 * wants an ISO string. Coerce here rather than in the contract — the contract is
 * law, and the response serializer validates against it, so a mapper that drifts
 * turns a 200 into a 500.
 */
const toApiUser = (row: {
  id: string
  email: string
  name: string | null
  createdAt: Date
}): User => ({
  id: row.id,
  email: row.email,
  // A person with no name yet still has an address. Never send null here: the
  // contract's `name` is not nullable.
  name: row.name ?? row.email,
  createdAt: row.createdAt.toISOString(),
})

const SEEDED_USER_MISSING =
  'No user in the database. Run `pnpm --filter @heli/server db:seed` and retry.'

const auth: FastifyPluginAsync = async (app) => {
  /**
   * Hackathon auth: the seeded user, no password. A real provider is out of
   * scope for P1 and would be reverted. The only thing that matters is that the
   * token it hands back is the same shape every protected route expects.
   */
  app.post(
    '/v1/auth/dev-login',
    {
      schema: {
        body: DevLoginRequest,
        response: { 200: DevLoginResponse },
      },
      // `DevLoginRequest` is the empty object, so `curl -X POST` with no body
      // and no content-type is still a well-formed request — there is simply
      // nothing for fastify to parse, which leaves `request.body` undefined and
      // would fail validation before the handler ever runs.
      preValidation: async (request) => {
        request.body ??= {}
      },
    },
    async (): Promise<DevLoginResponse> => {
      // The seeded, single-user deployment: whichever user exists is *the* user.
      const row = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
      if (!row) {
        throw Object.assign(new Error(SEEDED_USER_MISSING), { statusCode: 503 })
      }

      return { token: signUserToken(row.id), user: toApiUser(row) }
    },
  )
}

export default auth
