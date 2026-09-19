import { cn } from '@heli/ui'

/**
 * The Android app's live screen, drawn from `apps/mobile/app/index.tsx`: the same cards, the same
 * words, the same tokens. A nudge has just arrived because the person walked away from the desk.
 * The whole screen is drawn — nothing is cropped mid-card.
 */
export function Phone({ className }: { className?: string }) {
  return (
    <figure
      className={cn('relative w-[264px] shrink-0', className)}
      role="img"
      aria-label="The Lumi app on an Android phone: a nudge that the problem set is waiting, with Back to it and 10 minutes, while the spoken line plays"
    >
      {/* power and volume keys */}
      <span className="absolute -right-[3px] top-[118px] h-12 w-[3px] rounded-r-sm bg-ink-700" aria-hidden="true" />
      <span className="absolute -right-[3px] top-[186px] h-20 w-[3px] rounded-r-sm bg-ink-700" aria-hidden="true" />

      <div className="rounded-[40px] bg-ink-800 p-[6px] shadow-lg">
        <div className="flex aspect-[9/19.5] flex-col overflow-hidden rounded-[34px] bg-bg" aria-hidden="true">
          {/* status bar: punch-hole camera, clock left, radios right */}
          <div className="relative flex h-8 shrink-0 items-center justify-between px-5 pt-1 text-[11px] font-medium text-text">
            <span className="tnum">9:41</span>
            <span className="absolute left-1/2 top-2.5 size-[11px] -translate-x-1/2 rounded-pill bg-ink-900" />
            <span className="flex items-center gap-1">
              <Wifi />
              <Battery />
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-2.5 px-3.5 pt-3">
            <div className="flex items-center justify-between px-0.5">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[19px] font-semibold tracking-tight text-text">Lumi</span>
                <span className="text-[11px] text-text-faint">Pixel 8</span>
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <span className="size-1.5 rounded-pill bg-accent" />
                live
              </span>
            </div>

            <Card className="border-accent bg-accent-wash">
              <Label>Lumi says</Label>
              <p className="text-[14px] font-semibold leading-[1.35] text-text">
                Twelve minutes into the problem set, you left. Question four is still open.
              </p>
              <div className="flex gap-1.5 pt-0.5">
                <span className="rounded-sm bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg">Back to it</span>
                <span className="rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-[12px] font-semibold text-text">
                  10 minutes
                </span>
              </div>
            </Card>

            <Card>
              <div className="flex items-center justify-between">
                <Label>Speaking now</Label>
                <Wave />
              </div>
              <p className="text-[12px] leading-[1.4] text-text">A line from the observer is playing through this phone.</p>
            </Card>

            <Card>
              <div className="flex items-center justify-between">
                <Label>Usage access</Label>
                <span className="text-[11px] font-medium text-accent-link">granted</span>
              </div>
              <p className="text-[12px] leading-[1.4] text-text-muted">App time and unlocks. No messages, no content, ever.</p>
            </Card>

            <Card>
              <Label>What this phone reports</Label>
              <div className="grid grid-cols-3 gap-2 pt-0.5">
                <Stat value="Walking" label="motion" />
                <Stat value="14" label="unlocks" />
                <Stat value="6m" label="Instagram" />
              </div>
              <div className="flex justify-between border-t border-border pt-1.5 text-[10px] text-text-faint">
                <span>0 signals waiting</span>
                <span>flushing every 5 s</span>
              </div>
            </Card>
          </div>

          {/* gesture bar */}
          <span className="mx-auto mb-2 mt-auto h-1 w-24 shrink-0 rounded-pill bg-ink-900" />
        </div>
      </div>
    </figure>
  )
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-col gap-1.5 rounded-md border border-border bg-surface p-3', className)}>{children}</div>
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-text-faint">{children}</span>
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col">
      <span className="tnum text-[13px] font-semibold text-text">{value}</span>
      <span className="text-[10px] text-text-faint">{label}</span>
    </span>
  )
}

/** A still waveform: the line is playing. */
function Wave() {
  const bars = [5, 9, 12, 7, 10, 4, 8]
  return (
    <span className="flex h-3 items-center gap-[2px]">
      {bars.map((h, i) => (
        <span key={i} className="w-[2px] rounded-pill bg-accent" style={{ height: h }} />
      ))}
    </span>
  )
}

function Wifi() {
  return (
    <svg viewBox="0 0 16 12" className="h-2.5 w-3.5 fill-current">
      <path d="M8 12 0 3.3A11.3 11.3 0 0 1 8 0a11.3 11.3 0 0 1 8 3.3L8 12Z" />
    </svg>
  )
}

function Battery() {
  return (
    <svg viewBox="0 0 10 16" className="h-3 w-2 fill-current">
      <rect x="3" y="0" width="4" height="2" rx="0.5" />
      <rect x="0" y="2" width="10" height="14" rx="1.5" />
    </svg>
  )
}
