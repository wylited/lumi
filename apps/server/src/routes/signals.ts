import type { FastifyPluginAsync } from 'fastify'

import { SignalBatchRequest, SignalBatchResponse } from '@heli/contracts'
import type { SignalBatchResponse as SignalBatchResponseBody } from '@heli/contracts'

import { requireUser } from '../lib/jwt.js'
import { ingestSignals } from '../services/signals.js'

/**
 * `POST /v1/signals` — the desktop's batched transport (§7), for every signal
 * collected while it was offline.
 *
 * The body is `SignalBatch` and the socket's `signals` message is `SignalBatch`
 * verbatim, on purpose: both end in the same `ingestSignals` call, so the two
 * transports cannot disagree about a window. The socket replies
 * `{ t:'ack', accepted }` and this replies `{ accepted }` — the same number, from
 * the same return value.
 *
 * `requireUser`, not a device credential: these signals come from a person's own
 * machine, and the token already proves they are that person.
 *
 * The body carries a `deviceId`, which is *not* checked against the caller. The
 * deployment is one person, one device and one goal set (AGENTS.md, "Seeded,
 * single-user"), and a device it has not paired yet is exactly the case this
 * route has to accept: a desktop flushing a batch from a machine that was
 * offline when the session opened.
 */
/**
 * Fastify's default body limit is 1 MiB, and `SignalBatch` permits **500**
 * signals with a payload the contract never sizes. A desktop flushing a long
 * offline stretch is therefore able to post a batch that is legal by the
 * contract and refused by the server with a bare 413 -- measured: 500 signals
 * carrying ~2 KB of payload each is over the default. The limit is raised per
 * route rather than globally, so every other endpoint keeps the tighter default.
 *
 * 4 MiB is 500 signals at ~8 KB each, which is far past any realistic desktop
 * signal (the projection in `services/signals.ts` already drops payloads and
 * truncates titles) while still bounding a single request. A batch bigger than
 * this should be split by the sender; the residual gap -- that contract-valid
 * signals have no payload size cap at all -- belongs in `packages/contracts`,
 * not here.
 */
const SIGNAL_BATCH_BODY_LIMIT = 4 * 1024 * 1024

const signalsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/signals',
    {
      preHandler: requireUser,
      bodyLimit: SIGNAL_BATCH_BODY_LIMIT,
      schema: {
        body: SignalBatchRequest,
        response: { 200: SignalBatchResponse },
      },
    },
    async (request): Promise<SignalBatchResponseBody> => {
      const { deviceId, sessionId, signals } = request.body
      return ingestSignals(deviceId, sessionId, signals)
    },
  )
}

export default signalsRoutes
