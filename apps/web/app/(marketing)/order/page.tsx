import type { Metadata } from 'next'
import { ReserveForm } from '@/components/marketing/ReserveForm'
import { Unit } from '@/components/marketing/Unit'
import { price, PRICE } from '@/lib/product'

export const metadata: Metadata = { title: 'Order Lumi One' }

const INCLUDED = ['Lumi One', 'USB-C cable', 'Quick-start card', 'The Lumi desktop and phone apps, free']

export default function OrderPage() {
  return (
    <section className="mx-auto grid max-w-[1280px] gap-10 px-5 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:py-14">
      <div className="h-[380px] rounded-[28px] bg-surface lg:sticky lg:top-20 lg:h-[640px]">
        <Unit priority />
      </div>
      <div className="flex flex-col gap-8 lg:py-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-display-2 font-semibold tracking-tight text-text">Lumi One</h1>
          <span className="tnum text-title-2 text-text">{price(PRICE.unit)}</span>
        </div>
        <ul className="flex flex-col gap-2">
          {INCLUDED.map((i) => (
            <li key={i} className="flex items-center gap-3 text-body text-text-muted">
              <span className="size-1.5 rounded-pill bg-accent" aria-hidden="true" />
              {i}
            </li>
          ))}
        </ul>
        <ReserveForm />
      </div>
    </section>
  )
}
