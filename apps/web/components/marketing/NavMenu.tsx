'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

/** The nav's links at phone width, folded into a menu that closes on navigation and outside taps. */
export function NavMenu({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false)
  const path = usePathname()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => setOpen(false), [path])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={root} className="relative md:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Menu'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-9 items-center justify-center rounded-pill text-text hover:bg-ink-100"
      >
        <svg viewBox="0 0 18 18" className="size-[18px] stroke-current" fill="none" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" /> : <path d="M3 6h12M3 12h12" />}
        </svg>
      </button>
      {open ? (
        <nav aria-label="Menu" className="absolute right-0 top-11 flex w-56 flex-col rounded-[16px] border border-border bg-bg p-2 shadow-lg">
          {links.map((l) => (
            <Link
              key={l.href + l.label}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-sm px-3 py-2.5 text-body text-text hover:bg-ink-50"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  )
}
