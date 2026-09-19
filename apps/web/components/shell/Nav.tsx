'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@heli/ui'

const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/devices', label: 'Devices' },
] as const

export function Nav() {
  const path = usePathname()
  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active = path === link.href || path.startsWith(`${link.href}/`)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative rounded-pill px-3.5 py-1.5 text-small font-medium transition-colors duration-base ease-heli',
              active ? 'bg-surface text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
