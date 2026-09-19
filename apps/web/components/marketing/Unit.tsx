'use client'

import dynamic from 'next/dynamic'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@heli/ui'
import type { UnitState } from './DeviceScene'

/** three only loads on pages that show the unit, and never on the server. */
const Scene = dynamic(() => import('./DeviceScene').then((m) => m.DeviceScene), { ssr: false })

/**
 * A still of the unit renders at once; the live 3D scene mounts only when the unit is on screen and
 * the browser is idle, then fades in over the still. With `live={false}` it stays a still.
 */
export function Unit({
  state = 'watching',
  live = true,
  priority = false,
  className,
}: {
  state?: UnitState
  live?: boolean
  /** Set where the unit is the largest thing above the fold. */
  priority?: boolean
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [mount, setMount] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = host.current
    if (!live || !el) return
    let idle: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        io.disconnect()
        const go = () => setMount(true)
        // Safari has no requestIdleCallback.
        if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(go, { timeout: 2500 })
        else timer = setTimeout(go, 1200)
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (idle !== undefined) window.cancelIdleCallback(idle)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [live])

  const poster = state === 'shutter' ? 'shutter' : 'watching'
  return (
    <div ref={host} className={cn('relative h-full w-full', className)}>
      <Image
        src={`/unit/${poster}.webp`}
        alt="Lumi One"
        fill
        priority={priority}
        sizes="(min-width: 1024px) 600px, 100vw"
        className={cn('object-contain transition-opacity duration-slow', ready ? 'opacity-0' : 'opacity-100')}
      />
      {mount ? (
        <Scene
          state={state}
          onReady={() => setReady(true)}
          className={cn(
            'absolute inset-0 cursor-grab transition-opacity duration-slow active:cursor-grabbing',
            ready ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </div>
  )
}

const STATES: Array<{ id: UnitState; label: string; note: string }> = [
  { id: 'watching', label: 'Watching', note: 'One dim dot. Steady, never pulsing.' },
  { id: 'speaking', label: 'Speaking', note: 'The ring follows the voice.' },
  { id: 'shutter', label: 'Shutter closed', note: 'Two amber dots. Nothing leaves the unit.' },
  { id: 'idle', label: 'Idle', note: 'Off.' },
]

/** The unit with its states as a switch, so the ring and the shutter can be tried, not described. */
export function UnitStates({ className }: { className?: string }) {
  const [state, setState] = useState<UnitState>('watching')
  const current = STATES.find((s) => s.id === state)!
  return (
    <div className={cn('flex flex-col items-center gap-6', className)}>
      <div className="h-[460px] w-full md:h-[560px]">
        <Unit state={state} priority />
      </div>
      <div role="radiogroup" aria-label="Unit state" className="inline-flex rounded-pill bg-ink-100 p-1">
        {STATES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={s.id === state}
            onClick={() => setState(s.id)}
            className={cn(
              'whitespace-nowrap rounded-pill px-3 py-1.5 text-small outline-none sm:px-4 transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent',
              s.id === state ? 'bg-bg font-medium text-text shadow-sm' : 'text-text-muted hover:text-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="h-5 text-small text-text-muted" aria-live="polite">
        {current.note}
      </p>
    </div>
  )
}
