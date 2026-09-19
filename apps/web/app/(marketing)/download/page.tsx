import type { Metadata } from 'next'
import Link from 'next/link'
import { Tour } from '@/components/marketing/Tour'
import { DOWNLOAD } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Desktop app',
  description: 'Set the goal, see the session minute by minute, and learn what actually brings you back. Free.',
}

const PERMISSIONS = [
  { name: 'Screen Recording', reads: 'Window titles, and a small screen frame at most every ten seconds.', never: 'Password managers, banking apps, or the lock screen.' },
  { name: 'Input Monitoring', reads: 'How often you type and click, counted per 30 seconds.', never: 'Which keys. Not one character.' },
  { name: 'Accessibility', reads: 'Which part of the front app has focus.', never: 'What is written in it.' },
] as const

export default function DownloadPage() {
  return (
    <>
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col items-center gap-5 px-5 pt-16 text-center md:pt-24">
        <span className="text-body text-text-faint">Desktop app · Free</span>
        <h1 className="max-w-[15ch] text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance text-text md:text-display-1">
          Say what you are here to do. Watch it get done.
        </h1>
        <a href={DOWNLOAD.url} className="mt-2 rounded-pill bg-text px-6 py-3 text-body-strong font-medium text-bg hover:opacity-85">
          Download for macOS
        </a>
        <span className="text-small text-text-faint">{DOWNLOAD.requires} · works without Lumi One</span>
      </section>

      <section className="mx-auto max-w-[1100px] px-5 pt-14">
        <Tour />
      </section>

      <section className="mx-auto flex max-w-[var(--max-content)] flex-col gap-10 px-5 pt-32">
        <div className="flex flex-col gap-3">
          <h2 className="text-display-2 font-semibold text-text">Three permissions. Each one optional.</h2>
          <p className="max-w-[48ch] text-body text-text-muted">
            Say no to any of them and that signal is simply missing. Nothing else stops working.
          </p>
        </div>
        <div className="grid gap-px overflow-hidden rounded-[20px] border border-border bg-border md:grid-cols-3">
          {PERMISSIONS.map((p) => (
            <div key={p.name} className="flex flex-col gap-4 bg-bg p-7">
              <span className="text-title-3 font-semibold text-text">{p.name}</span>
              <p className="text-body text-text">{p.reads}</p>
              <p className="mt-auto border-t border-border pt-4 text-small text-text-muted">
                <span className="font-medium text-text">Never</span> — {p.never}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[var(--max-content)] px-5 py-32">
        <div className="flex flex-col items-start justify-between gap-6 rounded-[28px] bg-surface p-10 md:flex-row md:items-center">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-1 font-semibold text-text">Add eyes on the desk.</h2>
            <p className="text-body text-text-muted">Lumi One notices the phone in your hand — something no app on your computer can.</p>
          </div>
          <Link href="/device" className="rounded-pill border border-border-strong bg-bg px-6 py-3 text-body-strong font-medium text-text hover:bg-ink-50">
            See Lumi One
          </Link>
        </div>
      </section>
    </>
  )
}
