import Link from 'next/link'
import { Wordmark } from '@/components/shell/Mark'
import { price, PRICE } from '@/lib/product'

const LINKS = [
  { href: '/device', label: 'Lumi One' },
  { href: '/download', label: 'Desktop app' },
  { href: '/download#phone', label: 'Phone app' },
  { href: '/privacy', label: 'Privacy' },
]

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg">
      <div className="mx-auto flex h-14 max-w-[var(--max-content)] items-center gap-8 px-5">
        <Link href="/" aria-label="Lumi home" className="rounded-sm">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-small text-text-muted transition-colors hover:text-text">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/download" className="hidden rounded-pill px-3.5 py-1.5 text-small font-medium text-text hover:bg-ink-100 sm:inline-flex">
            Download
          </Link>
          <Link
            href="/order"
            className="rounded-pill bg-text px-4 py-1.5 text-small font-medium text-bg transition-opacity hover:opacity-85"
          >
            Order · {price(PRICE.unit)}
          </Link>
        </div>
      </div>
    </header>
  )
}
