import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodTypeAny } from 'zod'
import * as contracts from '../dist/index.js'

const topLevel: Record<string, ZodTypeAny> = {
  Signal: contracts.Signal,
  SignalBatch: contracts.SignalBatch,
  SignalWindow: contracts.SignalWindow,
  Goal: contracts.Goal,
  // The drafting step (HELI-072): the desktop renders a draft and the Python
  // side reads one, and neither hand-writes the shape.
  GoalDraft: contracts.GoalDraft,
  GoalDraftRequest: contracts.GoalDraftRequest,
  Policy: contracts.Policy,
  Assessment: contracts.Assessment,
  Intervention: contracts.Intervention,
  Observation: contracts.Observation,
  Session: contracts.Session,
  SessionSummary: contracts.SessionSummary,
  SessionDetail: contracts.SessionDetail,
  Device: contracts.Device,
  DeviceCaps: contracts.DeviceCaps,
  DeviceCommand: contracts.DeviceCommand,
  DeviceTelemetry: contracts.DeviceTelemetry,
  CommandAck: contracts.CommandAck,
  MediaStart: contracts.MediaStart,
  MediaStop: contracts.MediaStop,
  AudioOut: contracts.AudioOut,
  MediaStreamState: contracts.MediaStreamState,
  DeviceToApi: contracts.DeviceToApi,
  ApiToDevice: contracts.ApiToDevice,
  DesktopToApi: contracts.DesktopToApi,
  ApiToDesktop: contracts.ApiToDesktop,
  // The desk. The rig agent is Python and reads these rather than a copy.
  DeskRegistration: contracts.DeskRegistration,
  DeskRegisterResponse: contracts.DeskRegisterResponse,
  Desk: contracts.Desk,
  DeskAction: contracts.DeskAction,
  DeskAck: contracts.DeskAck,
  DeskHello: contracts.DeskHello,
  DeskHealth: contracts.DeskHealth,
  DeskToApi: contracts.DeskToApi,
  ApiToDesk: contracts.ApiToDesk,
  ApiDeskAudioOut: contracts.ApiDeskAudioOut,
  DeskFrameResponse: contracts.DeskFrameResponse,
  DeskStatus: contracts.DeskStatus,
  DeskActionRecord: contracts.DeskActionRecord,
  DeskSurveyResult: contracts.DeskSurveyResult,
  FrameRejectionCode: contracts.FrameRejectionCode,
  // The survey reading (HELI-091): the model's second output, written on the
  // observation row and read by the app's live view.
  ClutterReading: contracts.ClutterReading,
  // The phone. The app imports the package directly, but the schema is the
  // record of what crosses the socket, and the Python-side tools read this file.
  MobilePairCodeResponse: contracts.MobilePairCodeResponse,
  MobilePairRequest: contracts.MobilePairRequest,
  MobilePairResponse: contracts.MobilePairResponse,
  MobileToApi: contracts.MobileToApi,
  ApiToMobile: contracts.ApiToMobile,
  PhoneMotion: contracts.PhoneMotion,
  PhoneSnapshot: contracts.PhoneSnapshot,
  PhoneListResponse: contracts.PhoneListResponse,
  LiveEvent: contracts.LiveEvent,
}

const out: Record<string, unknown> = {}
for (const [name, schema] of Object.entries(topLevel)) {
  out[name] = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' })
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
await mkdir(outDir, { recursive: true })
await writeFile(resolve(outDir, 'json-schema.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
