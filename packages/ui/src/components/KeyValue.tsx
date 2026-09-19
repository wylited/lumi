import type { ReactNode } from 'react'
import { cn } from '../cn'

export interface KeyValueProps {
  items: Array<{ key: string; value: ReactNode }>
  className?: string
}

export function KeyValue({ items, className }: KeyValueProps) {
  return (
    <dl className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5', className)}>
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="min-w-0 text-small text-text-faint">{item.key}</dt>
          <dd className="tnum text-right text-small text-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
