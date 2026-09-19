'use client'

import { useState, useTransition } from 'react'
import { Button } from '@heli/ui'
import { sendCommand, type CommandType } from '@/app/(app)/devices/actions'

const ACTIONS: Array<{ type: CommandType; label: string; hint: string; payload?: object }> = [
  { type: 'identify', label: 'Identify', hint: 'Blink the LED so you know which unit this is' },
  { type: 'capture', label: 'Capture a frame', hint: 'One frame through the loop, now' },
  { type: 'stream.start', label: 'Start stream', hint: 'Continuous video to the relay' },
  {
    type: 'stream.stop',
    label: 'Stop stream',
    hint: 'Back to one frame per trigger',
    payload: { reason: null },
  },
]

export function Commands({ deviceId, online }: { deviceId: string; online: boolean }) {
  const [log, setLog] = useState<Array<{ at: string; label: string; ok: boolean; text: string }>>(
    [],
  )
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {ACTIONS.map((a) => (
          <Button
            key={a.type}
            variant="secondary"
            size="sm"
            title={a.hint}
            disabled={!online || pending}
            onClick={() =>
              start(async () => {
                const res = await sendCommand(deviceId, a.type, a.payload)
                const at = new Date().toLocaleTimeString('en-GB')
                setLog((l) =>
                  [{ at, label: a.label, ok: res.ok, text: res.message }, ...l].slice(0, 5),
                )
              })
            }
          >
            {a.label}
          </Button>
        ))}
      </div>
      {!online ? (
        <p className="text-caption text-text-faint">The unit is offline. Commands wait for it.</p>
      ) : null}
      {log.length ? (
        <ol className="flex flex-col gap-1.5 border-t border-border pt-3" aria-live="polite">
          {log.map((l, i) => (
            <li key={i} className="flex gap-3 text-caption">
              <span className="tnum font-mono text-text-faint">{l.at}</span>
              <span className="text-text">{l.label}</span>
              <span className={l.ok ? 'text-accent-link' : 'text-text-faint'}>{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
