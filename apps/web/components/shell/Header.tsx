import Link from 'next/link'
import { Pill } from '@heli/ui'
import type { DataSource } from '@/lib/api'
import { Wordmark } from './Mark'
import { Nav } from './Nav'

export function Header({ source }: { source: DataSource }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-6 px-5">
        <Link href="/" className="shrink-0 rounded-sm" aria-label="Helicopter home">
          <Wordmark />
        </Link>
        <Nav />
        <div className="ml-auto flex items-center gap-3">
          {source === 'demo' ? (
            <Pill
              tone="warn"
              dot
              title="No server configured or reachable — showing seeded demo data"
            >
              demo data
            </Pill>
          ) : (
            <Pill tone="accent" dot>
              live
            </Pill>
          )}
        </div>
      </div>
    </header>
  )
}
