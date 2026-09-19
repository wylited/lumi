import Link from 'next/link'
import { Wordmark } from '@/components/shell/Mark'

const COLS = [
  { title: 'Product', links: [['Lumi One', '/device'], ['Desktop app', '/download'], ['Order', '/order']] },
  { title: 'Trust', links: [['Privacy', '/privacy']] },
] as const

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-[var(--max-content)] gap-10 px-5 py-14 md:grid-cols-[1fr_auto_auto]">
        <div className="flex flex-col gap-3">
          <Wordmark />
          <p className="max-w-[36ch] text-small text-text-faint">
            Built for “Automate your studies, job, life.” One person, one desk, one goal at a time.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title} className="flex min-w-[140px] flex-col gap-2.5">
            <span className="text-small font-medium text-text">{c.title}</span>
            {c.links.map(([label, href]) => (
              <Link key={href} href={href} className="text-small text-text-muted hover:text-text">
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </footer>
  )
}
