import Image from 'next/image'
import { cn } from '@heli/ui'

/** A real screenshot of the app in a plain macOS window frame. */
export function MacWindow({
  src,
  alt,
  className,
  priority,
}: {
  src: string
  alt: string
  className?: string
  priority?: boolean
}) {
  return (
    <figure className={cn('overflow-hidden rounded-[12px] border border-border-strong/70 bg-bg shadow-lg', className)}>
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-surface px-3" aria-hidden="true">
        <span className="size-2.5 rounded-pill bg-ink-200" />
        <span className="size-2.5 rounded-pill bg-ink-200" />
        <span className="size-2.5 rounded-pill bg-ink-200" />
      </div>
      <Image src={src} alt={alt} width={2080} height={1360} priority={priority} className="block h-auto w-full" sizes="(min-width: 1024px) 760px, 100vw" />
    </figure>
  )
}
