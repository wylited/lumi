import { z } from 'zod'

export const SignalSource = z.enum([
  'desk',
  'screen',
  'app',
  'window',
  'input',
  'idle',
  'system',
  /** The phone: the surface the person takes with them (see `mobile.ts`). */
  'phone',
])
export type SignalSource = z.infer<typeof SignalSource>

export const SignalKind = z.string()
export type SignalKind = z.infer<typeof SignalKind>

export const SignalPayloadValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type SignalPayloadValue = z.infer<typeof SignalPayloadValue>

export const Signal = z.object({
  source: SignalSource,
  kind: SignalKind,
  ts: z.string(),
  confidence: z.number().min(0).max(1).default(1),
  payload: z.record(SignalPayloadValue),
})
export type Signal = z.infer<typeof Signal>

export const SignalBatch = z.object({
  deviceId: z.string(),
  sessionId: z.string().nullable(),
  signals: z.array(Signal).max(500),
})
export type SignalBatch = z.infer<typeof SignalBatch>

export const SignalWindowApp = z.object({
  app: z.string(),
  seconds: z.number().nonnegative(),
  onTask: z.boolean(),
})
export type SignalWindowApp = z.infer<typeof SignalWindowApp>

export const SignalWindowSite = z.object({
  title: z.string(),
  seconds: z.number().nonnegative(),
  onTask: z.boolean(),
})
export type SignalWindowSite = z.infer<typeof SignalWindowSite>

export const SignalWindow = z.object({
  from: z.string(),
  to: z.string(),
  windowMs: z.number().int(),
  focusedSeconds: z.number().nonnegative(),
  offTaskSeconds: z.number().nonnegative(),
  idleSeconds: z.number().nonnegative(),
  contextSwitches: z.number().int().nonnegative(),
  longestFocusRunSeconds: z.number().nonnegative(),
  inputRate: z.number().nonnegative(),
  onTaskRatio: z.number().min(0).max(1),
  topApps: z.array(SignalWindowApp).max(8),
  topSites: z.array(SignalWindowSite).max(8),
  focusMode: z.boolean(),
  lastFrameRef: z.string().nullable(),
  lastScreenRef: z.string().nullable(),
})
export type SignalWindow = z.infer<typeof SignalWindow>
