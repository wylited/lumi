import type { FastifyPluginAsync } from 'fastify'

import {
  MobilePairCodeResponse,
  MobilePairRequest,
  MobilePairResponse,
  MobileSignalBatch,
  PhoneListResponse,
  SignalBatchResponse,
} from '@heli/contracts'
import type {
  MobilePairCodeResponse as PairCodeBody,
  MobilePairResponse as PairBody,
  SignalBatchResponse as SignalBatchBody,
} from '@heli/contracts'

import { requireMobile, requireUser, signMobileToken } from '../lib/jwt.js'
import {
  applyPhoneSignals,
  issuePairCode,
  listPhones,
  openSessionId,
  redeemPairCode,
} from '../services/mobile.js'
import { ingestSignals } from '../services/signals.js'

/**
 * The phone's HTTP surface: pairing, and the flush it makes when the socket was
 * dead (a phone that spent the last hour in a lift).
 *
 * Pairing runs desktop → phone: the desktop asks for a code (`requireUser`),
 * shows it, and the phone exchanges it for a token. The exchange itself is
 * deliberately unauthenticated — the phone has no credentials yet, and the code
 * is the credential, single-use and five minutes long.
 */
export const prefix = '/v1'

const mobileRoutes: FastifyPluginAsync = async (app) => {
  /** The desktop asks for a code. */
  app.post(
    '/mobile/pair/code',
    { preHandler: requireUser, schema: { response: { 201: MobilePairCodeResponse } } },
    async (): Promise<PairCodeBody> => issuePairCode(),
  )

  /** The phone redeems it. */
  app.post(
    '/mobile/pair',
    { schema: { body: MobilePairRequest, response: { 201: MobilePairResponse } } },
    async (request): Promise<PairBody> => {
      const phoneId = redeemPairCode(request.body.code, {
        name: request.body.name,
        platform: request.body.platform,
        appVersion: request.body.appVersion,
      })
      const sessionId = await openSessionId()
      return { token: signMobileToken(phoneId), phoneId, sessionId }
    },
  )

  /**
   * The offline flush, identical to the socket's `signals` frame. The session is
   * resolved here, not named by the phone.
   */
  app.post(
    '/mobile/signals',
    {
      preHandler: requireMobile,
      schema: { body: MobileSignalBatch, response: { 200: SignalBatchResponse } },
    },
    async (request): Promise<SignalBatchBody> => {
      const phoneId = request.phoneId ?? 'unknown'
      const sessionId = await openSessionId()
      applyPhoneSignals(phoneId, request.body.signals, sessionId)
      return ingestSignals(phoneId, sessionId, request.body.signals)
    },
  )

  /** The paired phones, newest first. The desktop's setup screen reads this. */
  app.get(
    '/mobile/phones',
    { preHandler: requireUser, schema: { response: { 200: PhoneListResponse } } },
    async () => listPhones(),
  )
}

export default mobileRoutes
