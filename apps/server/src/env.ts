import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { z } from 'zod'

// Load a .env before validation. The package runs with cwd = apps/server, but
// tolerate being started from the repo root too. Existing process env wins.
for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'apps/server/.env')]) {
  if (existsSync(path)) {
    process.loadEnvFile(path)
  }
}

const requiredString = (name: string): z.ZodString =>
  z
    .string({
      required_error: `${name} is required`,
      invalid_type_error: `${name} must be a string`,
    })
    .min(1, `${name} must not be empty`)

const booleanish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
    .default(defaultValue)
    .transform((value) =>
      typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(value),
    )

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Required — the server will not boot without a database or a signing key.
  DATABASE_URL: requiredString('DATABASE_URL'),
  JWT_SECRET: requiredString('JWT_SECRET'),

  PORT: z.coerce.number().int().positive().default(3001),

  // Vision / assessment. Defaults to the offline stub so a keyless boot works.
  VISION_PROVIDER: z.enum(['deepseek', 'gemini', 'local']).default('local'),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  GEMINI_PROJECT: z.string().optional(),
  GEMINI_LOCATION: z.string().optional(),

  // Speech out. Same story: local works offline, ElevenLabs is key-gated.
  // The voice id is required next to the key by the adapter, so it is declared
  // here: this schema strips what it does not name, and a stripped voice id is
  // a provider that throws at the first spoken line.
  SPEECH_PROVIDER: z.enum(['local', 'elevenlabs']).default('local'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),

  MEDIA_ENABLED: booleanish(true),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish(true),

  DEMO_MODE: booleanish(false),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(env)'
    return `  - ${key}: ${issue.message}`
  })
  throw new Error(
    `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
      'Copy apps/server/.env.example to apps/server/.env and fill in the required keys.',
  )
}

export const env = parsed.data
export type Env = z.infer<typeof EnvSchema>

export const visionProvider = (): Env['VISION_PROVIDER'] => env.VISION_PROVIDER
export const speechProvider = (): Env['SPEECH_PROVIDER'] => env.SPEECH_PROVIDER
export const mediaEnabled = (): boolean => env.MEDIA_ENABLED
export const isDemoMode = (): boolean => env.DEMO_MODE
