import type { HTMLAttributes } from 'react'
import { cn } from '../cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
}

export function Card({ interactive = false, className, ...props }: CardProps) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-md border border-border bg-surface-raised',
        interactive &&
          'cursor-pointer transition-colors duration-base ease-heli hover:border-border-strong',
        className,
      )}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('flex flex-col gap-1 p-5 pb-0', className)} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...props} className={cn('text-title-3 text-text', className)} />
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('p-5', className)} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn('flex items-center gap-3 border-t border-border p-5', className)}
    />
  )
}
