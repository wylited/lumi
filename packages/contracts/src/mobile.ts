import { z } from 'zod'

import { Signal } from './signal.js'
import { ApiAudioOut, ApiError, ApiNudge } from './socket.js'

/**
 * The phone, as a monitored surface and an intervention target.
 *
 * The desktop watches the machine and the rig watches the desk; the phone is
 * the thing the person *takes with them*. Two consequences shape every shape in
 * this file:
 *
 *   - It is a **surface**: the loop can reach the person through it when they
 *     are not at the desk, with the same nudge and the same spoken line the
 *     desktop and the rig already carry. `ApiToMobile` is therefore a union of
 *     the same members — a second intervention vocabulary would be a second
 *     policy, and the policy decides, not the transport.
 *   - It is **honest about what it can see**: an Android phone reports app usage
 *     and unlocks; an iPhone does not, outside Apple's entitlement-gated Screen
 *     Time API. The signal vocabulary below names what is actually sent, and the
 *     platform field is carried all the way to the console so a gap is never
 *     mistaken for a quiet person.
 */

export const MOBILE_PLATFORMS = ['android', 'ios'] as const
export const MobilePlatform = z.enum(MOBILE_PLATFORMS)
export type MobilePlatform = z.infer<typeof MobilePlatform>

/* ---- pairing -------------------------------------------------------------- */

/**
 * Pairing is desktop-initiated, because the desktop is the trusted screen: the
 * person asks it for a code, the code is short-lived and single-use, and the
 * phone exchanges it for a token. This is the retired device-pairing idea with
 * the trust the other way round — the code never leaves the room.
 */
export const MobilePairCodeResponse = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    /** ISO-8601. Five minutes is a walk to the couch and back. */
    expiresAt: z.string(),
  })
  .strict()
export type MobilePairCodeResponse = z.infer<typeof MobilePairCodeResponse>

export const MobilePairRequest = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    /** What the person sees in the desktop's list — "Pixel 8". */
    name: z.string().min(1).max(64),
    platform: MobilePlatform,
    appVersion: z.string().min(1).max(40),
  })
  .strict()
export type MobilePairRequest = z.infer<typeof MobilePairRequest>

export const MobilePairResponse = z
  .object({
    /** A long-lived phone token. The phone never holds the user's token. */
    token: z.string(),
    phoneId: z.string(),
    /** The open session, when there is one, so the phone can say hello to it. */
    sessionId: z.string().nullable(),
  })
  .strict()
export type MobilePairResponse = z.infer<typeof MobilePairResponse>

/* ---- the phone socket ----------------------------------------------------- */

export const MobileHello = z
  .object({
    t: z.literal('hello'),
    appVersion: z.string(),
    platform: MobilePlatform,
    name: z.string(),
    /**
     * Null is allowed: a phone that opens before the person started watching
     * still connects, and the server resolves the open session on its own — the
     * phone is never told which session id to trust.
     */
    sessionId: z.string().nullable(),
  })
  .strict()
export type MobileHello = z.infer<typeof MobileHello>

/**
 * The same batch the HTTP fallback posts, so the socket-only shape and the
 * flush-after-offline shape cannot drift.
 */
export const MobileSignalBatch = z
  .object({ signals: z.array(Signal).max(500) })
  .strict()
export type MobileSignalBatch = z.infer<typeof MobileSignalBatch>

export const MobileSignals = z
  .object({ t: z.literal('signals') })
  .extend(MobileSignalBatch.shape)
  .strict()
export type MobileSignals = z.infer<typeof MobileSignals>

/** Whether the phone is playing a spoken line, so the server can judge barge-in. */
export const MobilePlayback = z
  .object({
    t: z.literal('playback'),
    playing: z.boolean(),
    momentId: z.string().nullable(),
  })
  .strict()
export type MobilePlayback = z.infer<typeof MobilePlayback>

export const MobileToApi = z.discriminatedUnion('t', [MobileHello, MobileSignals, MobilePlayback])
export type MobileToApi = z.infer<typeof MobileToApi>

export const MobileAck = z
  .object({ t: z.literal('ack'), accepted: z.number().int().nonnegative() })
  .strict()
export type MobileAck = z.infer<typeof MobileAck>

/**
 * A union, like `ApiToDesktop`: the phone receives the same nudge, the same
 * `audio.out` header, and the same error envelope. The tagged PCM that follows
 * `audio.out` is `MEDIA_TAG.audio` (`0x02`), exactly as the rig and the desktop
 * receive it.
 */
export const ApiToMobile = z.union([MobileAck, ApiAudioOut, ApiNudge, ApiError])
export type ApiToMobile = z.infer<typeof ApiToMobile>

/* ---- blocking ------------------------------------------------------------- */

/**
 * What the phone should block right now, polled by the app. Android only: the app's
 * accessibility service sends the person home from a listed app and says so in a notification
 * with undo. `active` is true only while a session is open and its goal allows changing things,
 * so a phone never blocks outside a session the person started.
 */
export const MobileBlocklist = z
  .object({
    active: z.boolean(),
    sessionId: z.string().nullable(),
    /** The goal's own words, for the notification. */
    goal: z.string().nullable(),
    /** App names as the goal lists them ("Instagram"), matched against Android's app labels. */
    apps: z.array(z.string()).max(50),
  })
  .strict()
export type MobileBlocklist = z.infer<typeof MobileBlocklist>

/* ---- the signal vocabulary ------------------------------------------------ */

/**
 * Named once, here, because both sides send and read them: the app above (in
 * TypeScript) and the Python-side tools that read `dist/json-schema.json`. The
 * payload fields follow `services/signals.ts`'s reader names (`app`, `seconds`,
 * `count`) so a phone signal folds into the same ring as everything else.
 */
export const PHONE_SIGNAL = {
  /** `{ app }` — the foreground app, Android only. */
  app: 'phone.app',
  /** `{ app, seconds }` — time in an app since the last batch, Android only. */
  usage: 'phone.usage',
  /** `{ count }` — unlocks since the last batch, Android only. */
  unlock: 'phone.unlock',
  /** `{ state }` — still | walking | running | driving | unknown. */
  motion: 'phone.motion',
  /** `{ screen: 'on'|'off', unlocked: boolean }`. */
  state: 'phone.state',
  /**
   * `{ action, observationId }` — what the person did with a nudge, reported on
   * the ordinary signal transport so the policy can judge the outcome, exactly
   * as the desktop reports it.
   */
  nudgeResponse: 'phone.nudge_response',
  /**
   * `{ action: 'sent_home'|'undone', app }` — the phone's blocker acted on a listed app, or the
   * person undid it. Android only; the counterpart of the desktop's `automation.*` signals.
   */
  automation: 'phone.automation',
} as const

export const PhoneMotion = z.enum(['still', 'walking', 'running', 'driving', 'unknown'])
export type PhoneMotion = z.infer<typeof PhoneMotion>

/**
 * What the server knows about a phone right now. Derived from signals, never
 * invented: `away` is the routing question — motion says the phone left the desk
 * — and a phone that has not spoken in two minutes is not "still", it is
 * unknown.
 */
export const PhoneSnapshot = z
  .object({
    phoneId: z.string(),
    name: z.string(),
    /** Which platform reports: Android sends app time and unlocks, iOS cannot. */
    platform: MobilePlatform,
    lastSeenAt: z.string(),
    /** The last foreground app, when the platform can report one. */
    app: z.string().nullable(),
    /** Seconds in that app in the current window (Android only). */
    appSeconds: z.number().nonnegative(),
    unlocks: z.number().int().nonnegative(),
    /**
     * Seconds per app since the server first heard this phone, most first, at most eight
     * (Android only). Running totals, like `unlocks`: a reader wanting a session's share
     * subtracts the totals it saw when the session began.
     */
    topApps: z
      .array(z.object({ app: z.string(), seconds: z.number().nonnegative() }).strict())
      .max(8)
      .default([]),
    motion: PhoneMotion,
    screenOn: z.boolean().nullable(),
    away: z.boolean(),
  })
  .strict()
export type PhoneSnapshot = z.infer<typeof PhoneSnapshot>

export const PhoneListResponse = z.array(PhoneSnapshot)
export type PhoneListResponse = z.infer<typeof PhoneListResponse>
