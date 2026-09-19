import type { Metadata } from 'next'
import Link from 'next/link'
import { MacWindow } from '@/components/marketing/MacWindow'
import { DOWNLOAD } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Helicopter desktop',
  description: 'The desktop app: set the goal, watch the session, and see what actually brings you back. Free.',
}

const PERMISSIONS = [
  { name: 'Screen Recording', reads: 'Window titles, and one small screen frame at most every 10 seconds.', never: 'Password managers and banking apps, or the lock screen.' },
  { name: 'Input Monitoring', reads: 'How often you type and click, per 30 seconds.', never: 'Which keys. No character is ever read.' },
  { name: 'Accessibility', reads: 'Which element of the front app has focus.', never: 'What is inside it.' },
] as const

const STEPS = [
  { n: '1', title: 'Say what you are here to do', body: 'Type it as a sentence. It drafts the goal — time, breaks, what counts as on and off — and you edit it.', shot: '/shots/goal.png', alt: 'The goal screen: a sentence becomes a goal with apps, sites and what it may do' },
  { n: '2', title: 'Work', body: 'Minutes fill in as you go. It stays quiet while you are on the goal and steps in only when you drift.', shot: '/shots/live.png', alt: 'The live screen: a ribbon of minutes and the interruptions so far' },
  { n: '3', title: 'See what brings you back', body: 'A week of focus, which interruptions worked, and what pulls you away — from the rows, not a guess.', shot: '/shots/history.png', alt: 'History: a week of focus and what brings you back' },
] as const

export default function DownloadPage() {
  return (
    <>
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col items-center gap-5 px-5 pt-16 text-center md:pt-24">
        <span className="text-body text-text-faint">Helicopter desktop</span>
        <h1 className="max-w-[16ch] text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance text-text md:text-display-1">
          The goal, the session, and what works.
        </h1>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <a href={DOWNLOAD.appleSilicon} className="rounded-pill bg-text px-6 py-3 text-body-strong font-medium text-bg hover:opacity-85">
            Download for Apple silicon
          </a>
          <a href={DOWNLOAD.intel} className="rounded-pill px-4 py-3 text-body-strong font-medium text-text-muted hover:text-text">
            Intel
          </a>
        </div>
        <span className="text-small text-text-faint">Free · {DOWNLOAD.requires} · works with or without the desk unit</span>
      </section>

      <section className="mx-auto max-w-[1100px] px-5 pt-14">
        <MacWindow src="/shots/live-nudge.png" alt="The desktop app during a session, with a nudge in the corner" priority />
      </section>

      <section className="mx-auto flex max-w-[var(--max-content)] flex-col gap-24 px-5 pt-32">
        {STEPS.map((s, i) => (
          <div key={s.n} className="grid items-center gap-10 md:grid-cols-[0.8fr_1.2fr]">
            <div className={`flex flex-col gap-3 ${i % 2 ? 'md:order-2' : ''}`}>
              <span className="tnum text-body text-text-faint">{s.n}</span>
              <h2 className="text-title-1 font-semibold text-text">{s.title}</h2>
              <p className="max-w-[40ch] text-body text-text-muted">{s.body}</p>
            </div>
            <MacWindow src={s.shot} alt={s.alt} />
          </div>
        ))}
      </section>

      <section className="mx-auto grid max-w-[var(--max-content)] gap-12 px-5 pt-32 md:grid-cols-[0.8fr_1.2fr]">
        <div className="flex flex-col gap-3">
          <h2 className="text-display-2 font-semibold text-text">It asks for three things.</h2>
          <p className="max-w-[38ch] text-body text-text-muted">
            Each is optional. Say no and that signal is simply absent — everything else keeps working.
          </p>
        </div>
        <div className="flex flex-col divide-y divide-border border-y border-border">
          {PERMISSIONS.map((p) => (
            <div key={p.name} className="grid gap-2 py-6 sm:grid-cols-[170px_1fr]">
              <span className="text-body-strong font-semibold text-text">{p.name}</span>
              <div className="flex flex-col gap-1.5">
                <span className="text-body text-text">{p.reads}</span>
                <span className="text-small text-text-faint">Never: {p.never}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[var(--max-content)] px-5 py-32">
        <div className="flex flex-col items-start justify-between gap-6 rounded-[28px] bg-surface p-10 md:flex-row md:items-center">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-1 font-semibold text-text">Add eyes on the desk.</h2>
            <p className="text-body text-text-muted">The desk unit sees the phone in your hand, which your computer never can.</p>
          </div>
          <Link href="/device" className="rounded-pill border border-border-strong bg-bg px-6 py-3 text-body-strong font-medium text-text hover:bg-ink-50">
            See the desk unit
          </Link>
        </div>
      </section>
    </>
  )
}
