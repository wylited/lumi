/**
 * The tray is the ambient tier. Its colour comes from the same tokens as every pixel in the app;
 * the Rust side just draws the dot it is told to.
 */
import { palette } from '@heli/tokens'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { logger } from './log'

const log = logger('tray')

export type TrayState = 'idle' | 'watching' | 'off_task' | 'speaking'

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const LOOK: Record<TrayState, { label: string; glyph: 'ring' | 'dot' | 'halo'; colour: string }> = {
  idle: { label: 'idle', glyph: 'ring', colour: palette.ink[300] },
  watching: { label: 'watching', glyph: 'dot', colour: palette.jade[400] },
  off_task: { label: 'off task', glyph: 'dot', colour: palette.amber[500] },
  speaking: { label: 'speaking', glyph: 'halo', colour: palette.jade[400] },
}

let last: TrayState | null = null

export function setTray(state: TrayState): void {
  if (state === last || !isTauri()) return
  last = state
  const look = LOOK[state]
  invoke('set_tray_state', { label: look.label, glyph: look.glyph, rgb: rgb(look.colour) }).catch(
    (error: unknown) => log.warn('could not update the tray', error),
  )
}
