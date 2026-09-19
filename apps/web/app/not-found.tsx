import Link from 'next/link'
import { Footer } from '@/components/marketing/Footer'
import { Nav } from '@/components/marketing/Nav'

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto flex w-full max-w-[var(--max-content)] flex-1 flex-col items-start justify-center gap-5 px-5 py-24">
        <span className="text-body text-text-faint">404</span>
        <h1 className="max-w-[16ch] text-display-2 font-semibold text-balance text-text md:text-display-1">Off the goal.</h1>
        <p className="text-body text-text-muted">There is no page here.</p>
        <Link href="/" className="rounded-pill bg-text px-5 py-2.5 text-body-strong font-medium text-bg hover:opacity-85">
          Back to the start
        </Link>
      </main>
      <Footer />
    </div>
  )
}
