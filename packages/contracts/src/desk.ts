import { z } from 'zod'

import { AudioOut } from './media.js'

/**
 * The desk: one Mac, a camera, and an arm that can point it.
 *
 * This replaces the device socket. There is no Pi and no pairing code; a desk
 * registers itself once and receives a token, and every action below travels
 * over `/ws/desk` with an ack. The rig agent in `apps/edge` is the only
 * implementation, and it reads `dist/json-schema.json` rather than a copy of
 * these shapes.
 */

export const DeskCamera = z
  .object({
    model: z.string().min(1),
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    /** Whether `camera.zoom` will do anything. */
    zoom: z.boolean().default(false),
  })
  .strict()
export type DeskCamera = z.infer<typeof DeskCamera>

export const DeskArm = z
  .object({
    model: z.string().min(1),
    dof: z.number().int().positive(),
    /** The serial device the agent opened, for the log and the panel. */
    port: z.string().nullable().default(null),
  })
  .strict()
export type DeskArm = z.infer<typeof DeskArm>

/** What the app sends once. `deskId` is stored locally, so re-running updates. */
export const DeskRegistration = z
  .object({
    deskId: z.string().min(1),
    name: z.string().min(1).max(60),
    camera: DeskCamera.nullable(),
    arm: DeskArm.nullable(),
  })
  .strict()
export type DeskRegistration = z.infer<typeof DeskRegistration>

export const Desk = z
  .object({
    id: z.string(),
    name: z.string(),
    camera: DeskCamera.nullable(),
    arm: DeskArm.nullable(),
    registeredAt: z.string(),
    lastSeenAt: z.string().nullable(),
  })
  .strict()
export type Desk = z.infer<typeof Desk>

export const DeskRegisterResponse = z
  .object({
    desk: Desk,
    /** Lets the rig talk to the server without holding the user's credentials. */
    deskToken: z.string(),
  })
  .strict()
export type DeskRegisterResponse = z.infer<typeof DeskRegisterResponse>

export const ArmPose = z
  .object({
    pan: z.number(),
    tilt: z.number(),
  })
  .strict()
export type ArmPose = z.infer<typeof ArmPose>

const ActionBase = { t: z.literal('action'), issuedAt: z.string() } as const

/**
 * One action. `arm.point` uses the calibration stored by the rig, so the server
 * never computes geometry; `capture` is the only one the loop needs for the
 * assessment path.
 */
export const DeskAction = z.discriminatedUnion('type', [
  z.object({ ...ActionBase, id: z.string(), type: z.literal('capture'), payload: z.object({ reason: z.string().nullable() }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('stream.start'), payload: z.object({ fps: z.number().int().min(1).max(20) }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('stream.stop'), payload: z.object({}).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('camera.zoom'), payload: z.object({ factor: z.number().positive().max(8) }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('arm.aim'), payload: z.object({ pan: z.number(), tilt: z.number() }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('arm.point'), payload: z.object({ x: z.number(), y: z.number() }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('arm.nod'), payload: z.object({ times: z.number().int().min(1).max(3) }).strict() }).strict(),
  z.object({ ...ActionBase, id: z.string(), type: z.literal('arm.home'), payload: z.object({}).strict() }).strict(),
  /**
   * Follow the person at the desk, or stop following them.
   *
   * The rig closes this loop on the pixels — a pose model finds the person, a control
   * law turns their chest's offset from the frame's centre into pan and tilt — so it
   * needs no calibration and no rectangle, and it is the one action that keeps moving
   * after its ack. `on: false` stops it and leaves the arm where it is.
   */
  z.object({ ...ActionBase, id: z.string(), type: z.literal('arm.track'), payload: z.object({ on: z.boolean() }).strict() }).strict(),
])
export type DeskAction = z.infer<typeof DeskAction>
export type DeskActionType = DeskAction['type']

/** Results are specific where it matters: an aim reports where it landed. */
export const DeskActionResult = z
  .object({
    pose: ArmPose.nullable().default(null),
    seq: z.number().int().nonnegative().nullable().default(null),
    zoom: z.number().positive().nullable().default(null),
    /** `audio.out`: how long the line took to play, in milliseconds. */
    durationMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict()
export type DeskActionResult = z.infer<typeof DeskActionResult>

export const CommandState = z.enum(['queued', 'dispatched', 'done', 'failed'])
export type CommandState = z.infer<typeof CommandState>

export const DeskAck = z
  .object({
    t: z.literal('action.ack'),
    actionId: z.string(),
    status: z.enum(['accepted', 'done', 'failed']),
    result: DeskActionResult.nullable().default(null),
    /** A readable reason on failure, for example `no_arm` or `serial_timeout`. */
    error: z.string().nullable().default(null),
  })
  .strict()
export type DeskAck = z.infer<typeof DeskAck>

export const DeskHello = z
  .object({
    t: z.literal('hello'),
    deskId: z.string(),
    agentVersion: z.string(),
    camera: DeskCamera.nullable(),
    arm: DeskArm.nullable(),
  })
  .strict()
export type DeskHello = z.infer<typeof DeskHello>

export const DeskHealth = z
  .object({
    t: z.literal('desk.health'),
    fps: z.number().nonnegative(),
    lastFrameAt: z.string().nullable(),
    armPose: ArmPose.nullable(),
    tempC: z.number().nullable().default(null),
    /** Frames accepted minus rejected since the process started. */
    framesSent: z.number().int().nonnegative().default(0),
    /** Whether the rig is following the person (`arm.track`). Null from a rig that does not say. */
    following: z.boolean().nullable().default(null),
  })
  .strict()
export type DeskHealth = z.infer<typeof DeskHealth>

export const DeskToApi = z.discriminatedUnion('t', [DeskHello, DeskHealth, DeskAck])
export type DeskToApi = z.infer<typeof DeskToApi>

export const DeskError = z
  .object({ t: z.literal('error'), code: z.string(), message: z.string() })
  .strict()
export type DeskError = z.infer<typeof DeskError>

/**
 * The spoken line, heard on the desk rather than only on the desktop. The header
 * names the moment and the format, and the **next** binary message on this
 * socket is that PCM, tagged `0x02` — `MEDIA_TAG.audio`, the same tag the device
 * contract used. The desk plays one line at a time and acks it with
 * `result.durationMs`.
 *
 * The rig owns the Mac's speakers (`docs/03-desk-capture.md`: "Playing the
 * line"), so the line has to be able to come down this socket and not only
 * through the desktop app.
 */
export const ApiDeskAudioOut = z
  .object({ t: z.literal('audio.out') })
  .extend(AudioOut.shape)
  .strict()
export type ApiDeskAudioOut = z.infer<typeof ApiDeskAudioOut>

export const ApiToDesk = z.union([DeskAction, ApiDeskAudioOut, DeskError])
export type ApiToDesk = z.infer<typeof ApiToDesk>

/** Why an upload was refused. The rig branches on these and never retries the same bytes. */
export const FrameRejectionCode = z.enum(['frame_not_jpeg', 'frame_too_large', 'frame_too_wide'])
export type FrameRejectionCode = z.infer<typeof FrameRejectionCode>

export const DeskFrameResponse = z
  .object({
    sessionId: z.string(),
    ref: z.string(),
    seq: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
export type DeskFrameResponse = z.infer<typeof DeskFrameResponse>

/** `GET /v1/desk` — what the desktop's desk panel and the rig both read. */
export const DeskStatus = z
  .object({
    desk: Desk.nullable(),
    session: z.object({ id: z.string(), goalId: z.string(), startedAt: z.string() }).strict().nullable(),
    frames: z.number().int().nonnegative(),
    hasFrame: z.boolean(),
    connected: z.boolean(),
    health: DeskHealth.nullable(),
  })
  .strict()
export type DeskStatus = z.infer<typeof DeskStatus>

export const DeskActionRecord = z
  .object({
    id: z.string(),
    type: z.string(),
    status: CommandState,
    issuedAt: z.string(),
    completedAt: z.string().nullable(),
    result: DeskActionResult.nullable(),
    error: z.string().nullable(),
  })
  .strict()
export type DeskActionRecord = z.infer<typeof DeskActionRecord>

export const DeskActionRequest = z
  .object({
    type: z.string(),
    payload: z.record(z.unknown()).default({}),
  })
  .strict()
export type DeskActionRequest = z.infer<typeof DeskActionRequest>
