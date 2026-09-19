'use server'

import QRCode from 'qrcode'

/**
 * The QR payload is the pairing code itself — nothing the device contract does not already
 * define. Dark modules use currentColor, so the code follows the theme.
 */
export async function qrSvg(code: string): Promise<string> {
  const svg = await QRCode.toString(code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
  return svg
    .replace(/fill="#ffffff"/gi, 'fill="none"')
    .replace(/stroke="#000000"/gi, 'stroke="currentColor"')
    .replace(/fill="#000000"/gi, 'fill="currentColor"')
}
