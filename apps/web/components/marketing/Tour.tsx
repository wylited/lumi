'use client'

import Image from 'next/image'
import { useState, type KeyboardEvent } from 'react'
import { cn } from '@heli/ui'

const STOPS = [
  { id: 'goal', label: 'Goal', caption: 'Type what you are here to do. It drafts the rest; you change what it got wrong.', src: '/shots/goal.png', alt: 'The goal screen: a sentence becomes a goal with time, breaks, and apps and sites on and off the goal' },
  { id: 'live', label: 'Live', caption: 'Each minute fills in. When you drift, it nudges — and you choose what happens next.', src: '/shots/live-nudge.png', alt: 'The live screen: a ribbon of minutes, and a nudge offering to go back to the goal' },
  { id: 'history', label: 'History', caption: 'Which interruptions actually brought you back, and what keeps pulling you away.', src: '/shots/history.png', alt: 'History: a week of focus, what brings you back, and what pulls you away' },
] as const

/** One window, three screens. Tabs switch the screenshot; arrow keys move between tabs. */
export function Tour() {
  const [i, setI] = useState(1)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setI((i + 1) % STOPS.length)
    if (e.key === 'ArrowLeft') setI((i + STOPS.length - 1) % STOPS.length)
  }
  return (
    <div className="flex flex-col items-center gap-6">
      <div role="tablist" aria-label="Screens" onKeyDown={onKey} className="inline-flex rounded-pill bg-ink-100 p-1">
        {STOPS.map((s, n) => (
          <button
            key={s.id}
            role="tab"
            id={`tab-${s.id}`}
            aria-selected={n === i}
            aria-controls="tour-panel"
            tabIndex={n === i ? 0 : -1}
            onClick={() => setI(n)}
            className={cn(
              'rounded-pill px-5 py-1.5 text-small outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent',
              n === i ? 'bg-bg font-medium text-text shadow-sm' : 'text-text-muted hover:text-text',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="h-12 max-w-[52ch] text-center text-body text-text-muted sm:h-auto" aria-live="polite">
        {STOPS[i]!.caption}
      </p>
      <div
        id="tour-panel"
        role="tabpanel"
        aria-labelledby={`tab-${STOPS[i]!.id}`}
        className="w-full overflow-hidden rounded-[14px] border border-border-strong/70 bg-bg shadow-lg"
      >
        <div className="flex h-8 items-center gap-1.5 border-b border-border bg-surface px-3.5" aria-hidden="true">
          <span className="size-2.5 rounded-pill bg-ink-200" />
          <span className="size-2.5 rounded-pill bg-ink-200" />
          <span className="size-2.5 rounded-pill bg-ink-200" />
        </div>
        <div className="relative aspect-[2080/1360]">
          {STOPS.map((s, n) => (
            <Image
              key={s.id}
              src={s.src}
              alt={n === i ? s.alt : ''}
              aria-hidden={n !== i}
              fill
              priority={n === 1}
              sizes="(min-width: 1100px) 1060px, 100vw"
              className={cn('object-cover transition-opacity duration-slow', n === i ? 'opacity-100' : 'opacity-0')}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
