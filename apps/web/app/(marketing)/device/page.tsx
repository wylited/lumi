import type { Metadata } from 'next'
import Link from 'next/link'
import { UnitStates } from '@/components/marketing/Unit'
import { price, PRICE } from '@/lib/product'

export const metadata: Metadata = {
  title: 'The desk unit',
  description: 'A camera, four microphones, a speaker and a mechanical shutter. It watches the desk while you work and stores nothing.',
}

const PARTS = [
  { name: 'Camera', value: 'Camera Module 3 Wide', body: 'On a head that tilts toward your desk. One frame when something changes — not a video of your day.' },
  { name: 'Microphones', value: '4-mic array', body: 'Hears when you talk over it, so a spoken line stops the moment you answer.' },
  { name: 'Speaker', value: 'Down-firing', body: 'One sentence at a time, and only after a nudge on screen did not work.' },
  { name: 'Light and shutter', value: '24-dot ring', body: 'A single dim dot while it watches. Slide the shutter shut and no frame leaves the unit.' },
] as const

const NEVER = [
  'Stores a frame. It sends, the desktop app decides, and nothing stays on the unit.',
  'Calls a model or holds a key. It has no idea what it is looking at.',
  'Sends anything with the shutter closed — within 200 ms of closing it.',
  'Animates while you are concentrating. A light that moves is a light that interrupts.',
] as const

const SPECS: Array<[string, string]> = [
  ['Computer', 'Raspberry Pi 5'],
  ['Camera', 'Camera Module 3 Wide, tilting head'],
  ['Audio', 'Four-mic array · down-firing speaker'],
  ['Light', '24-dot LED ring'],
  ['Privacy', 'Mechanical shutter, reported to the app'],
  ['Connection', 'Wi-Fi · pairs with a code from the desktop app'],
  ['Power', 'USB-C'],
  ['Works with', 'Helicopter desktop'],
]

export default function DevicePage() {
  return (
    <>
      <section className="mx-auto flex max-w-[var(--max-content)] flex-col items-center gap-4 px-5 pt-16 text-center md:pt-20">
        <span className="text-body text-text-faint">Desk unit</span>
        <h1 className="max-w-[18ch] text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance text-text md:text-display-1">
          It watches the desk, and keeps nothing.
        </h1>
        <div className="mt-2 flex items-center gap-4">
          <Link href="/order" className="rounded-pill bg-text px-6 py-3 text-body-strong font-medium text-bg hover:opacity-85">
            Order · {price(PRICE.unit)}
          </Link>
          <span className="text-small text-text-faint">Needs the free desktop app</span>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 pt-6">
        <div className="rounded-[28px] bg-surface pb-8">
          <UnitStates />
        </div>
      </section>

      <section className="mx-auto grid max-w-[var(--max-content)] gap-x-10 gap-y-12 px-5 pt-28 sm:grid-cols-2 lg:grid-cols-4">
        {PARTS.map((p) => (
          <div key={p.name} className="flex flex-col gap-2 border-t border-border pt-5">
            <span className="text-small text-text-faint">{p.name}</span>
            <span className="text-title-3 font-semibold text-text">{p.value}</span>
            <p className="text-small text-text-muted">{p.body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto grid max-w-[var(--max-content)] gap-12 px-5 pt-28 md:grid-cols-[0.9fr_1.1fr]">
        <h2 className="max-w-[14ch] text-display-2 font-semibold text-balance text-text">What it never does.</h2>
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {NEVER.map((n) => (
            <li key={n} className="py-5 text-body text-text">
              {n}
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto grid max-w-[var(--max-content)] gap-12 px-5 pt-28 md:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col gap-3">
          <h2 className="text-display-2 font-semibold text-text">Specs</h2>
          <p className="max-w-[36ch] text-body text-text-muted">
            In the box: the unit, a USB-C cable, and a card with its pairing code.
          </p>
        </div>
        <dl className="grid grid-cols-[140px_1fr] gap-x-6 border-t border-border">
          {SPECS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="border-b border-border py-4 text-small text-text-faint">{k}</dt>
              <dd className="border-b border-border py-4 text-body text-text">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="sticky bottom-0 z-30 mt-28 border-t border-border bg-bg">
        <div className="mx-auto flex max-w-[var(--max-content)] items-center justify-between gap-4 px-5 py-4">
          <span className="flex flex-col">
            <span className="text-body-strong font-semibold text-text">Helicopter desk unit</span>
            <span className="text-small text-text-faint">{price(PRICE.unit)} · reservation, no payment now</span>
          </span>
          <Link href="/order" className="rounded-pill bg-text px-6 py-2.5 text-body-strong font-medium text-bg hover:opacity-85">
            Order
          </Link>
        </div>
      </section>
    </>
  )
}
