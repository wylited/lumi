import type { MobilePairResponse, Signal } from '@heli/contracts'

/**
 * The two calls the phone makes over HTTP: pair, and flush the signals it
 * collected while the socket was down. Everything else is the socket.
 */

export const APP_VERSION = '0.1.0'

export const normalizeBase = (raw: string): string => raw.trim().replace(/\/+$/, '')

const messageOf = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: string; message?: string }
    return body.message ?? body.error ?? `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

export async function pairPhone(
  base: string,
  body: { code: string; name: string; platform: 'android' | 'ios'; appVersion: string },
): Promise<MobilePairResponse> {
  const response = await fetch(`${normalizeBase(base)}/v1/mobile/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await messageOf(response))
  return (await response.json()) as MobilePairResponse
}

export async function postSignals(
  base: string,
  token: string,
  signals: Signal[],
): Promise<{ accepted: number }> {
  const response = await fetch(`${normalizeBase(base)}/v1/mobile/signals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ signals }),
  })
  if (!response.ok) throw new Error(await messageOf(response))
  return (await response.json()) as { accepted: number }
}

/** `http(s)://host:port` → `ws(s)://host:port/ws/mobile`. */
export const socketUrl = (base: string): string =>
  `${normalizeBase(base).replace(/^http/, 'ws')}/ws/mobile`
