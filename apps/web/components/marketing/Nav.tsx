import Link from 'next/link'
import { Wordmark } from '@/components/shell/Mark'

export function MarketingNav() {
  return (
    <header className="mx-auto flex h-16 w-full max-w-[var(--max-content)] items-center gap-8 px-5">
      <Link href="/" aria-label="Helicopter home">
        <Wordmark />
      </Link>
      <nav
        aria-label="Sections"
        className="hidden items-center gap-6 text-small text-text-muted md:flex"
      >
        <a href="#loop" className="hover:text-text">
          How it works
        </a>
        <a href="#ladder" className="hover:text-text">
          What it does
        </a>
        <a href="#privacy" className="hover:text-text">
          Privacy
        </a>
      </nav>
      <Link
        href="/overview"
        className="ml-auto rounded-pill border border-border-strong px-4 py-1.5 text-small font-medium text-text transition-colors duration-base hover:border-accent hover:text-accent-link"
      >
        Open the dashboard
      </Link>
    </header>
  )
}
