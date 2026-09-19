import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@heli/ui'
import { frameUrl } from '../../lib/api'

/**
 * The newest frame of one source, fetched as fast as frames arrive (at most every `everyMs`). Labelled with its source and how old it is; with no frame
 * it is a labelled empty pane, never a stale image.
 */
export function FramePane({
  sessionId,
  source,
  label,
  empty,
  everyMs = 80,
  idle = 'Frames appear once a session is open.',
  className,
  children,
}: {
  sessionId: string | null
  source: 'camera' | 'screen'
  label: string
  empty: string
  everyMs?: number
  /** Shown when there is no session to read frames from. */
  idle?: string
  className?: string
  /** Drawn over the image, e.g. the aim rectangle. */
  children?: ReactNode
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [, tick] = useState(0)
  const current = useRef<string | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let live = true
    let seq: number | null = null
    // As fast as frames arrive, never faster than `everyMs`: the next request goes out when the
    // last one lands, so a slow link slows the pane down instead of piling requests up. A hidden
    // window stops asking.
    const loop = async () => {
      while (live) {
        const started = Date.now()
        if (document.visibilityState === 'visible') {
          const next = await frameUrl(sessionId, source, seq)
          if (!live) {
            if (next && next !== 'same') URL.revokeObjectURL(next.url)
            return
          }
          if (next && next !== 'same') {
            if (current.current) URL.revokeObjectURL(current.current)
            current.current = next.url
            seq = next.seq
            setUrl(next.url)
            setAt(next.at)
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(0, everyMs - (Date.now() - started))))
      }
    }
    void loop()
    const age = setInterval(() => tick((n) => n + 1), 1000)
    return () => {
      live = false
      clearInterval(age)
    }
  }, [sessionId, source, everyMs])

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current)
    },
    [],
  )

  const seconds = at === null ? null : Math.round((Date.now() - at) / 1000)
  const stale = seconds !== null && seconds > Math.max(10, (everyMs / 1000) * 5)
  return (
    <figure
      className={cn(
        'relative overflow-hidden rounded-md border border-border bg-surface',
        className,
      )}
    >
      {url && !stale ? (
        <img
          src={url}
          alt={`${label}, live`}
          className="block h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="grid h-full min-h-[140px] place-items-center p-6 text-center text-small text-text-faint">
          {sessionId ? empty : idle}
        </div>
      )}
      {url && !stale ? children : null}
      <figcaption className="absolute left-2 top-2 flex items-center gap-2 rounded-pill bg-bg/90 px-2.5 py-1 text-caption text-text">
        <span className={cn('size-1.5 rounded-pill', url && !stale ? 'bg-accent' : 'bg-ink-300')} />
        {label}
        {seconds !== null && !stale ? (
          <span className="tnum text-text-faint">{seconds <= 1 ? 'live' : `${seconds}s ago`}</span>
        ) : null}
      </figcaption>
    </figure>
  )
}
