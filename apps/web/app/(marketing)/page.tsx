import Link from 'next/link'
import { Ladder } from '@/components/marketing/Ladder'
import { MacWindow } from '@/components/marketing/MacWindow'
import { Phone } from '@/components/marketing/Phone'
import { RibbonKey, SessionRibbon } from '@/components/marketing/SessionRibbon'
import { Unit } from '@/components/marketing/Unit'
import { DOWNLOAD, price, PRICE } from '@/lib/product'

export default function Home() {
  return (
    <>
      {/* Hero: the pair, on a desk. */}
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col items-center gap-8 px-5 pb-12 pt-16 text-center md:pt-24">
        <h1 className="max-w-[16ch] text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-balance text-text md:text-[76px]">
          Set a goal. It makes sure it happens.
        </h1>
        <p className="max-w-[52ch] text-title-3 font-normal text-text-muted">
          A small unit on your desk and apps for your computer and phone notice when you drift — and step in only when it matters.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/order" className="rounded-pill bg-text px-6 py-3 text-body-strong font-medium text-bg transition-opacity hover:opacity-85">
            Order Lumi One · {price(PRICE.unit)}
          </Link>
          <Link href="/download" className="rounded-pill border border-border-strong px-6 py-3 text-body-strong font-medium text-text hover:bg-ink-50">
            Download the desktop app
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5">
        <div className="relative overflow-hidden rounded-[28px] bg-surface">
          <div className="grid items-end md:grid-cols-[0.8fr_1.2fr]">
            <div className="relative order-2 h-[340px] md:order-1 md:h-[560px]">
              <Unit priority />
            </div>
            <div className="order-1 px-5 pt-8 md:order-2 md:py-14 md:pl-0 md:pr-14">
              <MacWindow src="/shots/live-nudge.png" alt="The Lumi desktop app mid-session: a ribbon of minutes, and a nudge offering to go back to the goal" priority />
            </div>
          </div>
        </div>
      </section>

      {/* The proof: one session. */}
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col gap-8 px-5 pt-28 md:pt-36">
        <div className="grid gap-6 md:grid-cols-[1fr_1fr] md:items-end">
          <h2 className="max-w-[18ch] text-display-2 font-semibold text-balance text-text">
            Forty minutes.
            <br />
            It spoke up twice.
          </h2>
          <p className="max-w-[46ch] text-body text-text-muted md:justify-self-end">
            Each cell is a minute. A nudge at minute fourteen was ignored; the spoken line a minute later was not. The rest
            of the time, it said nothing — because nothing needed saying.
          </p>
        </div>
        <SessionRibbon />
        <RibbonKey />
      </section>

      {/* How it decides. */}
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col gap-12 px-5 pt-28 md:pt-36">
        <div className="flex flex-col gap-4">
          <h2 className="max-w-[20ch] text-display-2 font-semibold text-balance text-text">Quiet first.
            <br />
            Louder only if that fails.</h2>
          <p className="max-w-[54ch] text-body text-text-muted">
            A model reads the desk and the screen; your goal decides what it may do. Each step up happens only because the one
            below it did not work.
          </p>
        </div>
        <Ladder />
      </section>

      {/* The three parts. */}
      <section className="mx-auto grid max-w-[var(--max-content)] gap-5 px-5 pt-28 md:grid-cols-2 md:pt-36">
        <Link href="/device" className="group flex flex-col overflow-hidden rounded-[24px] bg-surface">
          <div className="flex flex-col gap-2 p-8 pb-0">
            <span className="text-small text-text-faint">Lumi One · {price(PRICE.unit)}</span>
            <h3 className="text-title-1 font-semibold text-text">Sees the desk. Never keeps it.</h3>
            <p className="text-body text-text-muted">Camera, four mics, a speaker and a mechanical shutter. Nothing is stored on it.</p>
            <span className="mt-2 text-body-strong font-medium text-accent-link group-hover:underline">See Lumi One →</span>
          </div>
          <div className="h-[340px]">
            <Unit state="shutter" live={false} />
          </div>
        </Link>
        <Link href="/download" className="group flex flex-col overflow-hidden rounded-[24px] bg-surface">
          <div className="flex flex-col gap-2 p-8">
            <span className="text-small text-text-faint">Desktop app · Free</span>
            <h3 className="text-title-1 font-semibold text-text">Reads the machine. Counts, not keys.</h3>
            <p className="text-body text-text-muted">The front app, window titles, how often you type. Your goal and your history live here.</p>
            <span className="mt-2 text-body-strong font-medium text-accent-link group-hover:underline">Get the app →</span>
          </div>
          <div className="mt-auto pl-8">
            <MacWindow src="/shots/history.png" alt="History in the desktop app: a week of focus and what brings you back" className="rounded-b-none rounded-r-none" />
          </div>
        </Link>
        <Link
          href="/download#phone"
          className="group flex flex-col overflow-hidden rounded-[24px] bg-surface md:col-span-2 md:flex-row md:items-end md:justify-between"
        >
          <div className="flex flex-col gap-2 p-8 md:max-w-[52ch] md:self-center md:p-12">
            <span className="text-small text-text-faint">Phone app · Free · Android</span>
            <h3 className="text-title-1 font-semibold text-text">Leave the desk. It comes along.</h3>
            <p className="text-body text-text-muted">
              Walk away and the nudge and the spoken line follow you to your phone. On Android it also reports app time and
              unlocks. Never messages, never content.
            </p>
            <span className="mt-2 text-body-strong font-medium text-accent-link group-hover:underline">Get the phone app →</span>
          </div>
          <div className="flex h-[420px] items-start justify-center overflow-hidden px-8 md:h-[480px] md:pr-20 md:pt-12">
            <Phone />
          </div>
        </Link>
      </section>

      {/* Privacy, in one breath. */}
      <section className="mx-auto max-w-[var(--max-content)] px-5 pt-28 md:pt-36">
        <p className="max-w-[40ch] text-title-1 font-semibold text-balance text-text md:text-display-2">
          Counts and titles, never keystrokes or page contents.{' '}
          <span className="text-text-faint">
            Every change it makes to your computer is shown and undone in one click. The shutter is mechanical. The phone sends counts, not messages.
          </span>
        </p>
        <Link href="/privacy" className="mt-6 inline-block text-body-strong font-medium text-accent-link hover:underline">
          How privacy works →
        </Link>
      </section>

      {/* Close. */}
      <section className="mx-auto max-w-[var(--max-content)] px-5 py-28 md:py-36">
        <div className="flex flex-col items-center gap-6 rounded-[28px] border border-border px-6 py-16 text-center">
          <h2 className="text-display-2 font-semibold text-balance text-text">Try it on your next forty minutes.</h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/order" className="rounded-pill bg-text px-6 py-3 text-body-strong font-medium text-bg hover:opacity-85">
              Order Lumi One
            </Link>
            <Link href="/download" className="rounded-pill border border-border-strong px-6 py-3 text-body-strong font-medium text-text hover:bg-ink-50">
              Download the desktop app
            </Link>
          </div>
          <span className="text-small text-text-faint">{DOWNLOAD.requires}. The apps work without the unit.</span>
        </div>
      </section>
    </>
  )
}
