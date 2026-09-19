'use client'

import { useState, useTransition } from 'react'
import { Button, Card, CardBody } from '@heli/ui'
import { rotateCode } from '@/app/(app)/devices/actions'

/**
 * The code, as text and as a QR the Pi can read with its own camera. Rotating invalidates the old
 * code on the server; the device has to pair again.
 */
export function Pairing({
  deviceId,
  code: initial,
  qrSvg: initialSvg,
  renderQr,
}: {
  deviceId: string
  code: string
  qrSvg: string
  renderQr: (code: string) => Promise<string>
}) {
  const [code, setCode] = useState(initial)
  const [svg, setSvg] = useState(initialSvg)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  return (
    <Card>
      <CardBody className="grid items-center gap-8 sm:grid-cols-[180px_1fr]">
        <div
          className="aspect-square w-full max-w-[180px] rounded-md bg-surface-raised p-3 text-text ring-1 ring-border [&_svg]:h-full [&_svg]:w-full"
          role="img"
          aria-label={`QR code for pairing code ${code}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-label uppercase text-text-faint">Pairing code</span>
            <span
              data-selectable
              className="tnum font-mono text-display-2 font-semibold tracking-wider text-text"
            >
              {code}
            </span>
          </div>
          <p className="text-small text-text-muted">
            Hold the QR up to the desk unit, or type the code into its setup. Pairing twice with the
            same code is harmless.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const res = await rotateCode(deviceId)
                  if (res.ok && res.code) {
                    setCode(res.code)
                    setSvg(await renderQr(res.code))
                  }
                  setNote({ ok: res.ok, text: res.message })
                })
              }
            >
              Rotate code
            </Button>
            {note ? (
              <span
                role="status"
                className={`text-caption ${note.ok ? 'text-accent-link' : 'text-text-faint'}`}
              >
                {note.text}
              </span>
            ) : null}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
