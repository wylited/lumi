import { Button } from '@heli/ui'

import { PhonePairing } from '../phone/PhonePairing'

/**
 * The fourth setup step: the phone.
 *
 * Pairing is desktop → phone because this screen is the trusted one — it asks
 * the server for a six-digit code and watches for the phone to appear. The step
 * is skippable on purpose: not everyone carries a phone into a session, and the
 * same pairing lives in Settings afterwards.
 */
export function PhoneStep({ onDone }: { onDone: () => void }) {
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

      <PhonePairing />

      <div className="flex items-center justify-between">
        <p className="text-caption text-text-faint">You can pair a phone later from Settings.</p>
        <Button onClick={onDone}>Start watching</Button>
      </div>
    </div>
  )
}
