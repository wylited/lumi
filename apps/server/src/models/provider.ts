import type { VisionProvider } from '../observe/types.js'
import { DEEPSEEK_DEFAULT_MODEL, createDeepSeekVisionProvider } from './deepseek.js'

/**
 * The only place a vision provider is chosen. There is no offline assessor: a
 * missing key is an error that names the variable, and the loop does not run.
 */
export interface VisionEnv {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_MODEL?: string
}

/** The logger shape the adapters accept. Matches the loop's logger and pino. */
export interface ProviderLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export const noopProviderLogger: ProviderLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Build the vision provider for this environment. Throws, naming the key, when there is none. */
export function createVisionProvider(env: VisionEnv, logger?: ProviderLogger): VisionProvider {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set: Lumi cannot see without it (apps/server/.env)')
  }
  return createDeepSeekVisionProvider({
    apiKey,
    model: env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
    logger,
  })
}
