import { useRef, useState, type PointerEvent } from 'react'
import type { Region } from '../../lib/setup'

/** Drag a rectangle over the preview. Reports it as fractions of the pane, 0–1. */
export function AimOverlay({
  value,
  onChange,
}: {
  value: Region | null
  onChange: (r: Region) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<Region | null>(null)

  const at = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const shape = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  })
  const shown = draft ?? value

  return (
    <div
      ref={box}
      role="application"
      aria-label="Drag a rectangle over the part of the desk to watch"
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = at(e)
        setDraft(shape(start.current, start.current))
      }}
      onPointerMove={(e) => start.current && setDraft(shape(start.current, at(e)))}
      onPointerUp={(e) => {
        if (start.current) {
          const r = shape(start.current, at(e))
          if (r.w > 0.03 && r.h > 0.03) onChange(r)
        }
        start.current = null
        setDraft(null)
      }}
    >
      {shown ? (
        <div
          className="absolute rounded-[4px] border-2 border-accent bg-accent/10"
          style={{
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`,
            height: `${shown.h * 100}%`,
          }}
        >
          <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-accent" />
        </div>
      ) : null}
    </div>
  )
}
