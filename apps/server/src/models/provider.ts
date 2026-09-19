import type { VisionProviderName } from '@heli/contracts'

import type { VisionProvider } from '../observe/types.js'
import { DEEPSEEK_DEFAULT_MODEL, createDeepSeekVisionProvider } from './deepseek.js'
import { createLocalVisionProvider } from './local.js'

/**
 * The only place a vision provider is chosen. It is deliberately key-driven:
 * a configured key means the real adapter, anything else means the offline
 * stub. The loop must boot and run with no credentials at all.
 */
export interface VisionEnv {
  VISION_PROVIDER?: string
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

/** Which adapter the environment resolves to. Key presence wins, never a default. */
export function visionProviderName(env: VisionEnv): VisionProviderName {
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.trim().length > 0) {
    return 'deepseek'
  }
  return 'local'
}

/** Build the vision provider for this environment. Never throws on a missing key. */
export function createVisionProvider(env: VisionEnv, logger?: ProviderLogger): VisionProvider {
  const name = visionProviderName(env)

  if (name === 'deepseek') {
    return createDeepSeekVisionProvider({
      apiKey: (env.DEEPSEEK_API_KEY ?? '').trim(),
      model: env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
      logger,
    })
  }

  return createLocalVisionProvider()
}
