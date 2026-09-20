import { readFileSync } from 'node:fs'

import { Assessment, ClutterLabel, ClutterReading } from '@heli/contracts'
import type { Goal, SignalWindow } from '@heli/contracts'

import type { AssessFrame, AssessInput, SurveyInput, VisionProvider } from '../observe/types.js'
import { noopProviderLogger, type ProviderLogger } from './provider.js'

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEFAULT_TIMEOUT_MS = 15_000

/** The width above which DeepSeek starts losing small text to its ~800px normalisation. */
export const TILE_MIN_WIDTH = 800

/**
 * The Assessment JSON Schema. It mirrors `packages/contracts/src/assessment.ts`
 * exactly; contracts is frozen, so this stays hand-written and small rather than
 * pulling `zod-to-json-schema` into the server.
 */
export const ASSESSMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['onTask', 'activity', 'kind', 'driftSeconds', 'evidence', 'confidence', 'because'],
  properties: {
    onTask: { type: 'boolean' },
    activity: { type: 'string' },
    kind: { type: ['string', 'null'] },
    driftSeconds: { type: 'integer', minimum: 0 },
    evidence: { type: 'array', items: { type: 'string', maxLength: 140 }, maxItems: 5 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    because: { type: 'string', maxLength: 200 },
  },
} as const

/**
 * The ClutterReading JSON Schema. Hand-written for the same reason as the
 * assessment one. The label list is read off the contract rather than retyped:
 * it is the one part of this shape the prompt quotes, so a second copy could
 * drift from the vocabulary the policy switches on.
 */
export const CLUTTER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'hotspots', 'evidence', 'confidence', 'because'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    hotspots: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['poseIndex', 'label', 'severity', 'at'],
        properties: {
          poseIndex: { type: 'integer', minimum: 0 },
          label: { type: 'string', enum: [...ClutterLabel.options] },
          severity: { type: 'number', minimum: 0, maximum: 1 },
          at: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: {
              x: { type: 'number', minimum: 0, maximum: 1 },
              y: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
    evidence: { type: 'array', items: { type: 'string', maxLength: 140 }, maxItems: 5 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    because: { type: 'string', maxLength: 200 },
  },
} as const

/*
 * The tiling trap, written down so nobody rediscovers it the hard way:
 * DeepSeek normalises an image toward ~800x800 before the vision encoder runs.
 * A 1600px page therefore arrives with its small text blurred away. The fix is
 * to send a 2x2 grid of overlapping crops (about 10% overlap) and ask for a
 * per-tile extraction. That fix needs a JPEG decode + crop + re-encode, and no
 * image library is available in `apps/server` (AGENTS.md forbids adding one
 * without its own chore commit). So `tileJpeg` computes the exact crop geometry
 * a real encoder would use and leaves `bytes` null for multi-tile crops; the
 * adapter sees the null and falls back to one whole frame at `detail: 'high'`.
 * That is an approximation, logged as `tiling: 'approximated'`, not a silent
 * lie. The day an encoder lands, only `tileJpeg` changes.
 */

export interface TileCrop {
  x: number
  y: number
  width: number
  height: number
  /** The encoded crop, or null when the runtime cannot re-encode a JPEG. */
  bytes: Buffer | null
}

/**
 * Pure geometry for the 2x2 overlapping crop. Never touches an image codec, so
 * it is deterministic and safe to unit-test. When the frame is small enough, or
 * its dimensions are unknown, it returns the whole frame as a single crop.
 */
export function tileJpeg(
  bytes: Buffer | null,
  width: number | null,
  height: number | null,
): TileCrop[] {
  if (!bytes || !width || !height || width <= TILE_MIN_WIDTH) {
    return [{ x: 0, y: 0, width: width ?? 0, height: height ?? 0, bytes }]
  }

  // 0.55 + 0.55 = 1.10, so the two columns overlap by 10% of the width.
  const tileWidth = Math.round(width * 0.55)
  const tileHeight = Math.round(height * 0.55)
  const xs = [0, width - tileWidth]
  const ys = [0, height - tileHeight]

  const crops: TileCrop[] = []
  for (const y of ys) {
    for (const x of xs) {
      crops.push({ x, y, width: tileWidth, height: tileHeight, bytes: null })
    }
  }
  return crops
}

/** A screen frame, or any window with sites open, is the text-dense case we can detect. */
function isTextDense(frame: AssessFrame, input: AssessInput): boolean {
  return frame.kind === 'screen' || input.window.topSites.length > 0
}

/** One part of the single user turn: the text, or one image. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'high' } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

type ResponseFormat = {
  /**
   * DeepSeek's Chat Completions endpoint does **not** offer `json_schema`
   * ("This response_format type is unavailable now", verified 2026-09), and
   * `json_object` requires the word "json" in the prompt. So the real path is
   * JSON mode plus the schema in the system prompt plus zod as the judge.
   */
  type: 'json_object'
}

interface ChatCompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[]
  usage?: ChatCompletionUsage
  error?: { message?: string }
}

const FALLBACK_SYSTEM_PROMPT =
  'You are an observer. Judge whether the person is working toward their stated goal. ' +
  'Return only JSON matching the Assessment schema. When evidence is weak, prefer ' +
  'onTask true with low confidence. `because` is for the operator and is never spoken.'

const FALLBACK_CLUTTER_PROMPT =
  'You are the eyes of an observer. Once in a while the camera is aimed across one person’s desk ' +
  'and you are asked one question: how cluttered is this desk? Return only JSON matching the ' +
  'ClutterReading schema. `because` is for the operator and is never spoken.'

let cachedSystemPrompt: string | null = null
let cachedClutterPrompt: string | null = null

function systemPrompt(): string {
  const base = cachedSystemPrompt ?? readPrompt()
  // JSON mode needs the shape in the prompt: the endpoint will not enforce a
  // schema, so the schema travels as text and zod is the final judge.
  return `${base}\n\nReturn only a JSON object matching this JSON Schema exactly, with no prose and no markdown fences:\n${JSON.stringify(ASSESSMENT_JSON_SCHEMA)}`
}

function readPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt
  try {
    cachedSystemPrompt = readFileSync(
      new URL('../observe/prompts/assess.md', import.meta.url),
      'utf8',
    )
  } catch {
    cachedSystemPrompt = FALLBACK_SYSTEM_PROMPT
  }
  return cachedSystemPrompt
}

function clutterSystemPrompt(): string {
  // Same reason as `systemPrompt`: JSON mode, no schema enforcement, so the
  // schema travels as text and zod is the final judge.
  return `${readClutterPrompt()}\n\nReturn only a JSON object matching this JSON Schema exactly, with no prose and no markdown fences:\n${JSON.stringify(CLUTTER_JSON_SCHEMA)}`
}

function readClutterPrompt(): string {
  if (cachedClutterPrompt !== null) return cachedClutterPrompt
  try {
    cachedClutterPrompt = readFileSync(
      new URL('../observe/prompts/clutter.md', import.meta.url),
      'utf8',
    )
  } catch {
    cachedClutterPrompt = FALLBACK_CLUTTER_PROMPT
  }
  return cachedClutterPrompt
}

function imagePart(bytes: Buffer, mediaType: string): ContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${bytes.toString('base64')}`, detail: 'high' },
  }
}

/** The goal and the window, in the same words both readings receive. */
function contextLines(input: { goal: Goal; window: SignalWindow }): string[] {
  const w = input.window
  const seconds = Math.round(w.windowMs / 1000)
  const goal = input.goal
  const apps = w.topApps.map((a) => `${a.app} ${Math.round(a.seconds)}s (${a.onTask ? 'on' : 'off'})`)
  const sites = w.topSites.map((s) => `${s.title} ${Math.round(s.seconds)}s (${s.onTask ? 'on' : 'off'})`)

  return [
    `Goal: ${goal.objective} (${goal.kind}).`,
    `Success: ${goal.successCriteria ?? 'not stated'}.`,
    `Window: ${seconds}s · on-task ${Math.round(w.onTaskRatio * 100)}% · focused ${Math.round(
      w.focusedSeconds,
    )}s · off-task ${Math.round(w.offTaskSeconds)}s · idle ${Math.round(w.idleSeconds)}s · switches ${
      w.contextSwitches
    } · longest run ${Math.round(w.longestFocusRunSeconds)}s · input ${w.inputRate}/30s · focusMode ${
      w.focusMode ? 'on' : 'off'
    }.`,
    `Top apps: ${apps.length > 0 ? apps.join(', ') : 'none'}.`,
    `Top sites: ${sites.length > 0 ? sites.join(', ') : 'none'}.`,
  ]
}

function buildUserText(input: AssessInput, imageCount: number, tiled: boolean): string {
  const images =
    imageCount === 0
      ? 'No frame was available for this window; judge from the metrics alone.'
      : tiled
        ? `${imageCount} images follow. They are overlapping tiles of ${imageCount} frame(s); extract per tile, then reconcile into one Assessment.`
        : `${imageCount} frame(s) follow. The desk frame is the camera; the screen frame is the display.`

  return [...contextLines(input), images, 'Return one Assessment.'].join('\n')
}

function buildSurveyUserText(input: SurveyInput, imageCount: number): string {
  const images =
    imageCount === 0
      ? 'No frame was available; there is nothing to read.'
      : `${imageCount} images follow, left to right across the desk. Return one clutter reading.`

  return [...contextLines(input), images].join('\n')
}

/** One assembled request: the messages to post, and what they carry. */
export interface BuiltRequest {
  messages: ChatMessage[]
  tiled: boolean
  approximated: boolean
  imageCount: number
}

interface ImageParts {
  parts: ContentPart[]
  tiled: boolean
  approximated: boolean
  imageCount: number
}

/**
 * One image part per frame that has bytes, in the order they arrived. The caller
 * says which frames are text-dense; the survey path says none of them, because a
 * desk frame carries no small text and a tile would make the model judge half a
 * desk twice.
 */
function imageParts(frames: AssessFrame[], isDense: (frame: AssessFrame) => boolean): ImageParts {
  const parts: ContentPart[] = []
  let tiled = false
  let approximated = false
  let imageCount = 0

  for (const frame of frames) {
    if (!frame.bytes) continue

    const shouldTile = frame.width !== null && frame.width > TILE_MIN_WIDTH && isDense(frame)
    const crops = shouldTile
      ? tileJpeg(frame.bytes, frame.width, frame.height)
      : [{ x: 0, y: 0, width: frame.width ?? 0, height: frame.height ?? 0, bytes: frame.bytes }]
    const encodable = crops.filter((crop): crop is TileCrop & { bytes: Buffer } => crop.bytes !== null)

    if (encodable.length > 1) {
      // Real tiling path. Unreachable while no JPEG encoder is available.
      tiled = true
      for (const crop of encodable) {
        parts.push(imagePart(crop.bytes, frame.mediaType))
        imageCount += 1
      }
    } else {
      if (shouldTile) approximated = true
      parts.push(imagePart(frame.bytes, frame.mediaType))
      imageCount += 1
    }
  }

  return { parts, tiled, approximated, imageCount }
}

/** Assemble the request. Images are only ever appended to the single user turn. */
export function buildMessages(input: AssessInput): BuiltRequest {
  const images = imageParts(input.frames, (frame) => isTextDense(frame, input))

  return {
    messages: [
      { role: 'system', content: systemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(input, images.imageCount, images.tiled) },
          ...images.parts,
        ],
      },
    ],
    tiled: images.tiled,
    approximated: images.approximated,
    imageCount: images.imageCount,
  }
}

/** The survey request: the clutter prompt, and every desk frame whole. */
export function buildSurveyMessages(input: SurveyInput): BuiltRequest {
  const images = imageParts(input.frames, () => false)

  return {
    messages: [
      { role: 'system', content: clutterSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildSurveyUserText(input, images.imageCount) },
          ...images.parts,
        ],
      },
    ],
    tiled: images.tiled,
    approximated: images.approximated,
    imageCount: images.imageCount,
  }
}

interface CallResult {
  ok: boolean
  status: number
  data: ChatCompletionResponse | null
  raw: string
}

async function callDeepSeek(
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<CallResult> {
  try {
    const response = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    let data: ChatCompletionResponse | null = null
    try {
      data = JSON.parse(raw) as ChatCompletionResponse
    } catch {
      data = null
    }
    return { ok: response.ok, status: response.status, data, raw }
  } catch (error) {
    return { ok: false, status: 0, data: null, raw: error instanceof Error ? error.message : '' }
  }
}

function stripFences(content: string): string {
  const trimmed = content.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** Parse defensively: a model may wrap JSON in prose or fences. zod is the judge. */
export function parseAssessmentContent(content: unknown): Assessment | null {
  if (typeof content !== 'string' || content.trim().length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(content))
  } catch {
    return null
  }
  const parsed = Assessment.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The same defensive parse, for the model's second and rarer reading. */
export function parseClutterContent(content: unknown): ClutterReading | null {
  if (typeof content !== 'string' || content.trim().length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(stripFences(content))
  } catch {
    return null
  }
  const parsed = ClutterReading.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface DeepSeekVisionProviderOptions {
  apiKey: string
  model?: string
  logger?: ProviderLogger
  timeoutMs?: number
}

/** The primary adapter. Images in, schema-validated Assessment out. */
export function createDeepSeekVisionProvider(
  options: DeepSeekVisionProviderOptions,
): VisionProvider {
  const apiKey = options.apiKey
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL
  const logger = options.logger ?? noopProviderLogger
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: 'deepseek',
    async assess(input: AssessInput): Promise<Assessment> {
      const started = Date.now()
      const built = buildMessages(input)
      let lastUsage: ChatCompletionUsage | null = null
      let lastFailure = 'unknown error'

      const callOnce = (format: ResponseFormat): Promise<CallResult> =>
        callDeepSeek(
          { model, messages: built.messages, temperature: 0, stream: false, response_format: format },
          apiKey,
          timeoutMs,
        )

      const attempt = async (format: ResponseFormat): Promise<Assessment | null> => {
        const result = await callOnce(format)
        if (!result.ok) {
          lastFailure =
            result.data?.error?.message ??
            (result.raw || (result.status ? `HTTP ${result.status}` : 'network error'))
          return null
        }
        lastUsage = result.data?.usage ?? null
        const parsed = parseAssessmentContent(result.data?.choices?.[0]?.message?.content)
        if (!parsed) lastFailure = 'response was not schema-valid Assessment JSON'
        return parsed
      }

      // JSON mode only: `json_schema` is unavailable on this endpoint, so the
      // schema is in the system prompt and zod validates the reply. One retry
      // covers a transient malformed response.
      let assessment = await attempt({ type: 'json_object' })

      if (!assessment) {
        logger.warn(
          { provider: 'deepseek', model, reason: lastFailure },
          'deepseek assessment parse failed, retrying once',
        )
        assessment = await attempt({ type: 'json_object' })
      }

      if (!assessment) {
        throw new Error(`deepseek assessment failed: ${lastFailure}`)
      }

      // The closure assignments above are invisible to control-flow narrowing.
      const usage = lastUsage as ChatCompletionUsage | null

      logger.info(
        {
          provider: 'deepseek',
          model,
          latencyMs: Date.now() - started,
          format: 'json_object',
          tiling: built.tiled ? 'tiled' : built.approximated ? 'approximated' : 'none',
          images: built.imageCount,
          promptTokens: usage?.prompt_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
        },
        'vision.assess',
      )

      return assessment
    },
    async survey(input: SurveyInput): Promise<ClutterReading> {
      const started = Date.now()
      const built = buildSurveyMessages(input)
      let lastFailure = 'unknown error'

      const attempt = async (): Promise<ClutterReading | null> => {
        const result = await callDeepSeek(
          {
            model,
            messages: built.messages,
            temperature: 0,
            stream: false,
            response_format: { type: 'json_object' } satisfies ResponseFormat,
          },
          apiKey,
          timeoutMs,
        )
        if (!result.ok) {
          lastFailure =
            result.data?.error?.message ??
            (result.raw || (result.status ? `HTTP ${result.status}` : 'network error'))
          return null
        }
        const parsed = parseClutterContent(result.data?.choices?.[0]?.message?.content)
        if (!parsed) lastFailure = 'response was not schema-valid ClutterReading JSON'
        return parsed
      }

      // Same JSON mode as `assess`, and the same single retry: a reading that
      // will not parse becomes silence at the caller, never a guess.
      let reading = await attempt()

      if (!reading) {
        logger.warn(
          { provider: 'deepseek', model, reason: lastFailure },
          'deepseek clutter parse failed, retrying once',
        )
        reading = await attempt()
      }

      if (!reading) {
        throw new Error(`deepseek survey failed: ${lastFailure}`)
      }

      logger.info(
        {
          provider: 'deepseek',
          model,
          latencyMs: Date.now() - started,
          imageCount: built.imageCount,
          score: reading.score,
          hotspots: reading.hotspots.length,
          confidence: reading.confidence,
        },
        'vision.survey',
      )

      return reading
    },
  }
}
