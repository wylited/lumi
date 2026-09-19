import { useEffect, useState } from 'react'

import type { MobilePairCodeResponse, PhoneSnapshot } from '@heli/contracts'
import { Button } from '@heli/ui'

import { Group, Row } from '../kit'
import { api, serverBase } from '../../lib/api'

/**
 * The fourth step: the phone.
 *
 * Pairing is desktop → phone because this screen is the trusted one — it asks
 * the server for a six-digit code, shows it once, and watches for the phone to
 * appear. The code is single-use and dies in five minutes, so the countdown is
 * not decoration: an expired code refuses, and saying so here is kinder than
 * letting the person type it twice.
 *
 * Skippable on purpose. Not everyone carries a phone into a session, and the
 * step says so; the phones can be paired later from Settings.
 */

function clockLeft(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function seenAgo(lastSeenAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(lastSeenAt)) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return `${minutes} min ago`
}

function describe(phone: PhoneSnapshot, now: number): string {
  const parts = [`seen ${seenAgo(phone.lastSeenAt, now)}`]
  if (phone.away) parts.push('away from the desk')
  else if (phone.motion === 'walking' || phone.motion === 'running') parts.push('moving')
  if (phone.app !== null) parts.push(phone.appSeconds > 0 ? `${phone.app} · ${Math.round(phone.appSeconds)} s` : phone.app)
  if (phone.unlocks > 0) parts.push(`${phone.unlocks} unlock${phone.unlocks === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function PhoneStep({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState<MobilePairCodeResponse | null>(null)
  const [asking, setAsking] = useState(false)
  const [phones, setPhones] = useState<PhoneSnapshot[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const list = await api.phones()
      if (alive) setPhones(list)
    }
    void poll()
    const every = setInterval(() => void poll(), 3000)
    return () => {
      alive = false
      clearInterval(every)
    }
  }, [])

  async function ask(): Promise<void> {
    setAsking(true)
    const issued = await api.pairCode().catch(() => null)
    setAsking(false)
    setCode(issued)
  }

  const expired = code !== null && Date.parse(code.expiresAt) <= now
  const admitted = phones[0] !== undefined

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-title1 font-semibold text-text">Bring the phone</h1>
        <p className="max-w-[62ch] text-body text-text-muted">
          Open the Lumi app on the phone, type this Mac's address, and enter the code below. The phone
          then reports what Android honestly allows — app time, unlocks, motion — and can be spoken
          to when you walk away from the desk.
        </p>
      </header>

      <Group
        title="Pairing code"
        footer={
          admitted
            ? 'Paired. You can pair another phone from Settings.'
            : 'The code works once and expires after five minutes.'
        }
      >
        <Row label="On the phone" detail={`${serverBase()} · or this Mac's Wi-Fi address if the phone cannot reach localhost`}>
          <Button variant="secondary" onClick={() => void ask()} loading={asking}>
            {code === null || expired ? 'Get a code' : 'New code'}
          </Button>
        </Row>
        <Row
          label="Code"
          detail={code === null ? 'Ask for one — nothing is shown until you do.' : expired ? 'Expired. Ask again.' : `expires in ${clockLeft(code.expiresAt, now)}`}
          wide
        >
          <span
            className={
              code === null || expired
                ? 'tnum font-mono text-title2 text-text-faint'
                : 'tnum font-mono text-title2 tracking-[0.35em] text-text'
            }
          >
            {code === null || expired ? '———' : code.code}
          </span>
        </Row>
      </Group>

      <Group
        title="Phones"
        footer={
          admitted
            ? 'A paired phone is a second surface: nudges prefer it, and spoken lines follow it when you are away.'
            : 'None yet. The step is skippable — nothing else needs a phone.'
        }
      >
        {phones.length === 0 ? (
          <Row label="No phone paired" detail="The app's pairing screen takes the code above." />
        ) : (
          phones.map((phone) => (
            <Row
              key={phone.phoneId}
              label={phone.name}
              detail={describe(phone, now)}
              align="start"
            >
              <span className="text-caption text-text-faint">{phone.platform}</span>
            </Row>
          ))
        )}
      </Group>

      <div className="flex items-center justify-between">
        <p className="text-caption text-text-faint">You can pair a phone later from Settings.</p>
        <Button onClick={onDone}>{admitted ? 'Start watching' : 'Skip for now'}</Button>
      </div>
    </div>
  )
}
