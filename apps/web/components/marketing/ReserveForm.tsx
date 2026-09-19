'use client'

import { useState, type FormEvent } from 'react'
import { cn } from '@heli/ui'
import { price, PRICE } from '@/lib/product'
import { Reservation } from '@/lib/reservation'

const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Netherlands', 'Rwanda', 'Kenya', 'Nigeria', 'India', 'Japan', 'Australia', 'Other']

const field =
  'h-11 w-full rounded-[10px] border border-border-strong bg-bg px-3.5 text-body text-text outline-none placeholder:text-text-faint focus:border-text'

export function ReserveForm() {
  const [quantity, setQuantity] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState<number | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const body = Reservation.safeParse({
      name: f.get('name'),
      email: f.get('email'),
      country: f.get('country'),
      quantity,
    })
    if (!body.success) {
      setError(body.error.issues[0]?.message ?? 'Check the form')
      return
    }
    setError(null)
    setPending(true)
    try {
      const res = await fetch('/api/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body.data),
      })
      const json = (await res.json()) as { position?: number; error?: string }
      if (!res.ok || !json.position) throw new Error(json.error ?? 'Something went wrong')
      setDone(json.position)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setPending(false)
    }
  }

  if (done !== null) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <span className="text-small text-text-faint">Reserved</span>
        <h2 className="text-title-1 font-semibold text-text">You are number {done} on the list.</h2>
        <p className="text-body text-text-muted">
          Nothing was charged. We will email you before any unit ships, and you can say no then. In the meantime the desktop app
          works on its own.
        </p>
        <a href="/download" className="mt-2 self-start rounded-pill border border-border-strong px-5 py-2.5 text-body-strong font-medium text-text hover:bg-ink-50">
          Download the desktop app
        </a>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <div className="flex items-center justify-between border-y border-border py-4">
        <span className="text-body text-text">Quantity</span>
        <div className="flex items-center gap-1" role="group" aria-label="Quantity">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={quantity === n}
              onClick={() => setQuantity(n)}
              className={cn(
                'tnum size-9 rounded-pill text-body outline-none focus-visible:ring-2 focus-visible:ring-accent',
                quantity === n ? 'bg-text text-bg' : 'text-text-muted hover:bg-ink-100',
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-small text-text-muted">Name</span>
          <input name="name" autoComplete="name" className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-small text-text-muted">Email</span>
          <input name="email" type="email" autoComplete="email" className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-small text-text-muted">Ships to</span>
          <select name="country" defaultValue="United States" className={field}>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-baseline justify-between">
        <span className="text-body text-text-muted">Total</span>
        <span className="tnum text-title-2 font-semibold text-text">{price(PRICE.unit * quantity)}</span>
      </div>

      {error ? (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-pill bg-text text-body-strong font-medium text-bg transition-opacity hover:opacity-85 disabled:opacity-50"
      >
        {pending ? 'Reserving…' : 'Reserve — no payment now'}
      </button>
      <p className="text-small text-text-faint">
        A reservation holds your place. We email before anything ships, and you pay only if you still want it then.
      </p>
    </form>
  )
}
