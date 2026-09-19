import Link from 'next/link'
import { fixtures, SEED_SESSION_ID } from '@heli/fixtures'
import { HeroConsole } from '@/components/marketing/HeroConsole'
import { Ladder } from '@/components/marketing/Ladder'
import { Loop } from '@/components/marketing/Loop'
import { MarketingNav } from '@/components/marketing/Nav'
import { Strip, StripLegend } from '@/components/session/Strip'

const BUDGETS = [
  { value: '≤ 4 s', label: 'from a signal to a decision' },
  { value: '90 s', label: 'minimum between spoken lines' },
  { value: '3 min', label: 'minimum between nudges' },
  { value: '1 click', label: 'to undo anything it changed' },
  { value: '0', label: 'keystrokes or page bodies stored' },
]

export default function Landing() {
  const seed = fixtures().session(SEED_SESSION_ID)
  const obs = seed?.observations ?? []
  const acted = obs.filter((o) => o.tier > 0).length
  const spoke = obs.filter((o) => o.tier === 3).length

  return (
    <div className="flex min-h-dvh flex-col">
      <MarketingNav />

      <main className="flex flex-col">
        {/* Hero */}
        <section className="mx-auto grid w-full max-w-[var(--max-content)] items-center gap-16 px-5 pb-24 pt-16 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div className="flex flex-col gap-7">
            <span className="text-label uppercase text-accent-link">
              Automate your studies, job, life
            </span>
            <h1 className="text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance text-text md:text-display-0">
              Set a goal. It makes sure you get it done.
            </h1>
            <p className="measure text-title-3 font-normal text-text-muted">
              A camera on the desk and an app on your Mac watch for drift. Most of the time
              Helicopter stays silent. When it matters, it nudges, speaks, or changes the machine —
              and records whether it worked.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/overview"
                className="rounded-pill bg-accent-strong px-6 py-3 text-body-strong font-medium text-accent-contrast transition-colors duration-base hover:bg-accent-strong-hover"
              >
                See a week of it
              </Link>
              <a
                href="#loop"
                className="rounded-pill px-4 py-3 text-body-strong font-medium text-text-muted hover:text-text"
              >
                How it decides →
              </a>
            </div>
          </div>
          <div className="pt-10 lg:pt-0">
            <HeroConsole />
          </div>
        </section>

        {/* The proof: a session, one cell per minute */}
        <section className="border-y border-border bg-surface">
          <div className="mx-auto flex w-full max-w-[var(--max-content)] flex-col gap-6 px-5 py-16">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="max-w-[28ch] text-title-1 font-semibold text-balance text-text">
                Forty minutes, {obs.length - acted} of them silent. It stepped in {acted} times and
                spoke {spoke === 1 ? 'once' : `${spoke} times`}.
              </h2>
              <StripLegend />
            </div>
            <Strip observations={obs} />
            <p className="text-small text-text-faint">
              The demo session, one cell per minute. The nudge at minute 14 was ignored; the spoken
              line a minute later was not. A quiet session is a result, not a gap.
            </p>
          </div>
        </section>

        {/* The loop */}
        <section
          id="loop"
          className="mx-auto flex w-full max-w-[var(--max-content)] scroll-mt-8 flex-col gap-10 px-5 py-24"
        >
          <Heading eyebrow="How it works" title="Six steps, and the model is only one of them." />
          <Loop />
        </section>

        {/* The ladder */}
        <section
          id="ladder"
          className="mx-auto flex w-full max-w-[var(--max-content)] scroll-mt-8 flex-col gap-10 px-5 pb-24"
        >
          <Heading
            eyebrow="What it does"
            title="It earns every step up."
            lede="A nudge becomes a spoken line because the nudge did not work — not because time passed. Come back and it drops to silence."
          />
          <Ladder />
        </section>

        {/* Budgets */}
        <section className="border-y border-border">
          <dl className="mx-auto grid w-full max-w-[var(--max-content)] grid-cols-2 gap-px bg-border md:grid-cols-5">
            {BUDGETS.map((b) => (
              <div key={b.label} className="flex flex-col gap-2 bg-bg px-5 py-10">
                <dt className="order-2 text-small text-text-muted">{b.label}</dt>
                <dd className="tnum order-1 text-display-2 font-semibold text-text">{b.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Privacy, plainly */}
        <section
          id="privacy"
          className="mx-auto w-full max-w-[var(--max-content)] scroll-mt-8 px-5 py-24"
        >
          <p className="max-w-[46ch] text-title-1 font-semibold text-balance text-text">
            It keeps counts and titles, never keystrokes or page bodies.{' '}
            <span className="text-text-muted">
              Everything it does to your machine is logged and undone in one click, and the shutter
              on the desk unit is mechanical.
            </span>
          </p>
        </section>

        {/* CTA */}
        <section className="mx-auto w-full max-w-[var(--max-content)] px-5 pb-24">
          <div
            data-surface="console"
            className="flex flex-col items-start justify-between gap-8 rounded-lg bg-bg p-10 text-text md:flex-row md:items-center md:p-14"
          >
            <div className="flex flex-col gap-2">
              <h2 className="text-display-2 font-semibold text-balance">
                What actually gets you back on task?
              </h2>
              <p className="text-body text-text-muted">
                A week of sessions answers it. Look at the numbers.
              </p>
            </div>
            <Link
              href="/overview"
              className="shrink-0 rounded-pill bg-accent-strong px-6 py-3 text-body-strong font-medium text-accent-contrast transition-colors duration-base hover:bg-accent-strong-hover"
            >
              Open the dashboard
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[var(--max-content)] flex-wrap items-center justify-between gap-4 px-5 py-8 text-caption text-text-faint">
          <span>Helicopter — built for “Automate your studies / job / life”.</span>
          <span>One person, one desk, one goal at a time.</span>
        </div>
      </footer>
    </div>
  )
}

function Heading({ eyebrow, title, lede }: { eyebrow: string; title: string; lede?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-label uppercase text-text-faint">{eyebrow}</span>
      <h2 className="max-w-[24ch] text-display-2 font-semibold text-balance text-text">{title}</h2>
      {lede ? <p className="measure text-body text-text-muted">{lede}</p> : null}
    </div>
  )
}
