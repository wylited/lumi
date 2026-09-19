import { z } from 'zod'

export const VisionProviderName = z.enum(['deepseek', 'gemini', 'local'])
export type VisionProviderName = z.infer<typeof VisionProviderName>

export const SpeechProviderName = z.enum(['local', 'elevenlabs'])
export type SpeechProviderName = z.infer<typeof SpeechProviderName>
