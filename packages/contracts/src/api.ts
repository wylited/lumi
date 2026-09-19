import { z } from 'zod'
import { Goal } from './goal.js'
import { Policy } from './policy.js'
import { Device, DeviceState } from './device.js'
import { SignalBatch, SignalWindow } from './signal.js'
import { Session, SessionDetail } from './session.js'
import { Observation } from './observation.js'
import { Intervention, Tier, Outcome } from './intervention.js'
import { MediaStreamState } from './media.js'

export const User = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.string(),
})
export type User = z.infer<typeof User>

export const DevLoginRequest = z.object({}).strict()
export type DevLoginRequest = z.infer<typeof DevLoginRequest>

export const DevLoginResponse = z.object({
  token: z.string(),
  user: User,
})
export type DevLoginResponse = z.infer<typeof DevLoginResponse>

export const PairDeviceRequest = z.object({ code: z.string() }).strict()
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>

export const PairDeviceResponse = z.object({
  device: Device,
  deviceToken: z.string(),
})
export type PairDeviceResponse = z.infer<typeof PairDeviceResponse>

export const DeviceListResponse = z.array(Device)
export type DeviceListResponse = z.infer<typeof DeviceListResponse>

export const RotateCodeResponse = z.object({
  deviceId: z.string(),
  code: z.string(),
})
export type RotateCodeResponse = z.infer<typeof RotateCodeResponse>

export const SignalBatchRequest = SignalBatch
export type SignalBatchRequest = z.infer<typeof SignalBatchRequest>

export const SignalBatchResponse = z.object({
  accepted: z.number().int().nonnegative(),
})
export type SignalBatchResponse = z.infer<typeof SignalBatchResponse>

export const SignalWindowResponse = SignalWindow
export type SignalWindowResponse = z.infer<typeof SignalWindowResponse>

export const GoalCreateRequest = Goal.omit({ id: true, createdAt: true, policy: true }).extend({
  policy: Policy.optional(),
})
export type GoalCreateRequest = z.infer<typeof GoalCreateRequest>

export const GoalUpdateRequest = GoalCreateRequest.partial()
export type GoalUpdateRequest = z.infer<typeof GoalUpdateRequest>

export const GoalResponse = Goal
export type GoalResponse = z.infer<typeof GoalResponse>

export const GoalListResponse = z.array(Goal)
export type GoalListResponse = z.infer<typeof GoalListResponse>

export const OpenSessionRequest = z.object({
  deviceId: z.string(),
  goalId: z.string().nullable(),
})
export type OpenSessionRequest = z.infer<typeof OpenSessionRequest>

export const OpenSessionResponse = z.object({
  session: Session,
  goal: Goal.nullable(),
  policy: Policy,
})
export type OpenSessionResponse = z.infer<typeof OpenSessionResponse>

export const CloseSessionRequest = z.object({
  reason: z.string().optional(),
})
export type CloseSessionRequest = z.infer<typeof CloseSessionRequest>

export const SessionListResponse = z.array(Session)
export type SessionListResponse = z.infer<typeof SessionListResponse>

export const SessionDetailResponse = SessionDetail
export type SessionDetailResponse = z.infer<typeof SessionDetailResponse>

export const AnalyticsSummary = z.object({
  focusedMinutes: z.number().nonnegative(),
  offTaskMinutes: z.number().nonnegative(),
  interventions: z.number().int().nonnegative(),
  longestFocusRunSeconds: z.number().nonnegative(),
  tierHistogram: z.record(z.number().int().nonnegative()),
})
export type AnalyticsSummary = z.infer<typeof AnalyticsSummary>

export const AnalyticsTierRow = z.object({
  tier: Tier,
  outcome: Outcome,
  count: z.number().int().nonnegative(),
})
export type AnalyticsTierRow = z.infer<typeof AnalyticsTierRow>

export const AnalyticsTiersResponse = z.array(AnalyticsTierRow)
export type AnalyticsTiersResponse = z.infer<typeof AnalyticsTiersResponse>

export const AnalyticsAppRow = z.object({
  app: z.string(),
  seconds: z.number().nonnegative(),
  onTask: z.boolean(),
})
export type AnalyticsAppRow = z.infer<typeof AnalyticsAppRow>

export const AnalyticsAppsResponse = z.array(AnalyticsAppRow)
export type AnalyticsAppsResponse = z.infer<typeof AnalyticsAppsResponse>

export const AnalyticsHeatmapRow = z.object({
  hour: z.number().int().min(0).max(23),
  onTaskRatio: z.number().min(0).max(1),
})
export type AnalyticsHeatmapRow = z.infer<typeof AnalyticsHeatmapRow>

export const AnalyticsHeatmapResponse = z.array(AnalyticsHeatmapRow)
export type AnalyticsHeatmapResponse = z.infer<typeof AnalyticsHeatmapResponse>

export const SpeakRequest = z.object({ text: z.string().min(1).max(220) }).strict()
export type SpeakRequest = z.infer<typeof SpeakRequest>

export const SpeakResponse = z.object({
  accepted: z.boolean(),
  reason: z.string().nullable(),
  intervention: Intervention.nullable(),
})
export type SpeakResponse = z.infer<typeof SpeakResponse>

export const MediaStateResponse = MediaStreamState
export type MediaStateResponse = z.infer<typeof MediaStateResponse>

export const SampleResponse = z.object({
  observationId: z.string(),
})
export type SampleResponse = z.infer<typeof SampleResponse>

export const LiveState = z.object({
  sessionId: z.string(),
  deviceState: DeviceState.nullable(),
  media: MediaStreamState.nullable(),
})
export type LiveState = z.infer<typeof LiveState>

export const LiveEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('observation'), data: Observation }),
  z.object({ event: z.literal('intervention'), data: Intervention }),
  z.object({ event: z.literal('signal.window'), data: SignalWindow }),
  z.object({ event: z.literal('state'), data: LiveState }),
])
export type LiveEvent = z.infer<typeof LiveEvent>
