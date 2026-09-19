'use server'

import { z } from 'zod'
import { RotateCodeResponse } from '@heli/contracts'
import { write } from '@/lib/api'

export type ActionResult =
  { ok: true; message: string; code?: string } | { ok: false; message: string }

export async function rotateCode(deviceId: string): Promise<ActionResult> {
  const res = await write(
    `/devices/${encodeURIComponent(deviceId)}/rotate-code`,
    RotateCodeResponse,
  )
  if (!res.ok) return { ok: false, message: res.reason }
  return { ok: true, message: 'New code issued. The old one no longer pairs.', code: res.data.code }
}

const COMMANDS = ['capture', 'stream.start', 'stream.stop', 'identify', 'led.set'] as const
export type CommandType = (typeof COMMANDS)[number]

/**
 * The web issues device commands through the server's control plane. The route is not in the
 * contract yet (docs/01-contracts.md §7); until it is, the panel reports that honestly.
 */
export async function sendCommand(
  deviceId: string,
  type: CommandType,
  payload: object = {},
): Promise<ActionResult> {
  if (!COMMANDS.includes(type)) return { ok: false, message: 'Unknown command.' }
  const res = await write(
    `/devices/${encodeURIComponent(deviceId)}/commands`,
    z.object({ id: z.string() }).passthrough(),
    { type, payload },
  )
  if (!res.ok) return { ok: false, message: res.reason }
  return { ok: true, message: `Sent · ${res.data.id}` }
}
