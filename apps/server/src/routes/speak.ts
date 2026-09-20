import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

import { SpeakRequest, SpeakResponse } from '@heli/contracts'
import type { Intervention } from '@heli/contracts'
import type { SpeakResponse as SpeakResponseBody } from '@heli/contracts'

import { env } from '../env.js'
import { requireUser } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { childLogger } from '../logger.js'
import { sessionExists } from '../services/session.js'
import { deliverIntervention } from '../voice/push.js'
import { createSpeechProvider } from '../voice/speech.js'
import { createLoopSenders } from '../voice/surfaces.js'
import { createTransport, transportSenders } from '../voice/transport.js'

export const prefix = '/v1'

const log = childLogger({ module: 'speak' })

const SpeakParams = z.object({ id: z.string().min(1) })
const NotFound = z.object({ error: z.string() })

/**
 * `POST /v1/sessions/:id/speak` — say this line, now.
 *
 * The loop reaches tier 3 on its own, and that is the product: a line arrives
 * because the policy decided, minutes into a session. This route is the other
 * half of the same sentence — the same synthesis, the same transport, the same
 * `deliverIntervention` the loop calls — reached from a button instead of a
 * decision. It exists for the two moments the decision cannot serve: a live
 * demonstration that has to show the voice now rather than when someone happens
 * to drift, and a bench check of the speaker path without waiting for a real
 * distraction.
 *
 * It is **not** a way around the policy: it never fabricates an assessment, it
 * writes an `Intervention` with `reason: 'manual'` and no observation, and the
 * tier it records is the tier it delivered (3 — one sentence out loud).
 *
 * `accepted` is the honest answer to "did it come out of a speaker": synthesis
 * failure, an empty key or no attached surface all answer `false` with the
 * reason, because a spoken line nobody heard is not a delivery.
 */
const speakRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/sessions/:id/speak',
    {
      preHandler: requireUser,
      schema: {
        params: SpeakParams,
        body: SpeakRequest,
        response: { 200: SpeakResponse, 404: NotFound },
      },
    },
    async (request, reply): Promise<SpeakResponseBody | undefined> => {
      const { id } = request.params
      if (!(await sessionExists(id))) return reply.code(404).send({ error: `No session ${id}.` })

      const text = request.body.text.trim()
      const intervention: Intervention = {
        tier: 3,
        channel: 'speech',
        message: text,
        action: null,
        reversible: false,
        reason: 'manual',
      }

      let speech
      try {
        speech = createSpeechProvider(env)
      } catch (error) {
        log.warn({ err: error, sessionId: id }, 'speak: no provider, nothing was said')
        return {
          accepted: false,
          reason: 'no speech provider: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must both be set',
          intervention: null,
        }
      }

      const result = await deliverIntervention({
        intervention,
        sessionId: id,
        language: 'en',
        speech,
        transport: createTransport(transportSenders(createLoopSenders())),
        logger: log,
      })

      /**
       * Recorded whether or not it was heard, and with the delivery in the reason:
       * `Intervention` has no column for it (contracts, not this route, own that
       * shape), and a row that says only "someone asked for a line" is the record
       * the demo needs — the failure reason is what makes it actionable.
       */
      try {
        await prisma.intervention.create({
          data: {
            sessionId: id,
            tier: 3,
            channel: 'speech',
            message: text,
            reversible: false,
            reason: result.delivered ? 'manual: delivered' : 'manual: not delivered',
          },
        })
      } catch (error) {
        log.error({ err: error, sessionId: id }, 'speak: could not record the line')
      }

      return {
        accepted: result.delivered,
        reason: result.delivered
          ? null
          : 'nothing carried it: no desktop app and no rig were attached to speak through',
        intervention,
      }
    },
  )
}

export default speakRoutes
