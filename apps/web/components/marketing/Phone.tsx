import { cn } from '@heli/ui'

/**
 * The phone app's live screen, drawn from `apps/mobile/app/index.tsx`: the same cards, the same
 * words, the same tokens. A nudge has just arrived because the person walked away from the desk.
 */
export function Phone({ className }: { className?: string }) {
  return (
    <figure
      className={cn(
        'w-[280px] shrink-0 rounded-[44px] border border-border-strong/70 bg-ink-900 p-[9px] shadow-lg',
        className,
      )}
      role="img"
      aria-label="The Lumi phone app: a nudge that says the problem set is waiting, with Back to it and 10 minutes"
    >
      <div className="flex h-[560px] flex-col gap-3 overflow-hidden rounded-[36px] bg-bg px-4 pt-3" aria-hidden="true">
        <div className="flex h-6 items-center justify-between px-2 text-[11px] font-medium text-text">
          <span className="tnum">9:41</span>
          <span className="h-[18px] w-[72px] rounded-pill bg-ink-900" />
          <span className="tnum">82%</span>
        </div>

        <div className="flex items-center justify-between pt-2">
          <span className="flex items-baseline gap-2">
            <span className="text-title-2 font-semibold text-text">Lumi</span>
            <span className="text-caption text-text-faint">Pixel</span>
          </span>
          <span className="flex items-center gap-1.5 text-caption text-text-muted">
            <span className="size-2 rounded-pill bg-accent" />
            live
          </span>
        </div>

        <Card className="border-accent bg-accent-wash">
          <Label>Lumi says</Label>
          <p className="text-body-strong font-semibold text-text">
            You walked off twelve minutes into the problem set. Back to question four?
          </p>
          <div className="flex gap-2">
            <span className="rounded-sm bg-accent px-3.5 py-2 text-small font-semibold text-bg">Back to it</span>
            <span className="rounded-sm border border-border bg-surface-raised px-3.5 py-2 text-small font-semibold text-text">
              10 minutes
            </span>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <Label>Speaking now</Label>
            <span className="size-2 rounded-pill bg-accent opacity-60" />
          </div>
          <p className="text-small text-text">A line from the observer is playing through this phone.</p>
        </Card>

        <Card>
          <Label>What this phone reports</Label>
          <p className="text-small text-text-muted">
            Motion, whether the screen is on, and — with usage access — the app in front, time in each app and
            unlocks. No messages, no content, ever.
          </p>
        </Card>
      </div>
    </figure>
  )
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-col gap-2 rounded-md border border-border bg-surface p-4', className)}>{children}</div>
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-faint">{children}</span>
}
