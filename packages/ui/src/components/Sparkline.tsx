import { useId } from 'react'
import { cn } from '../cn'

export interface SparklineProps {
  /** Ratios in [0, 1], oldest first. */
  values: number[]
  /** Draws a dashed line at this ratio — e.g. the on-task floor the policy cares about. */
  threshold?: number
  /** Points to show; older values scroll off the left. */
  capacity?: number
  height?: number
  label: string
  className?: string
}

const W = 100

/**
 * Inline SVG, no chart library. Colour comes from `currentColor`, so the caller picks the tone
 * with a text class (`text-accent`).
 */
export function Sparkline({
  values,
  threshold,
  capacity,
  height = 48,
  label,
  className,
}: SparklineProps) {
  const gradient = useId()
  const n = capacity ?? Math.max(values.length, 2)
  const shown = values.slice(-n)
  const step = W / Math.max(n - 1, 1)
  const offset = (n - shown.length) * step
  const y = (v: number) => 2 + (1 - Math.min(1, Math.max(0, v))) * (height - 4)
  const points = shown.map((v, i) => [offset + i * step, y(v)] as const)
  const line = points
    .map(([x, py], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${py.toFixed(2)}`)
    .join('')
  const last = points[points.length - 1]
  const first = points[0]
  const area =
    first && last ? `${line}L${last[0].toFixed(2)},${height}L${first[0].toFixed(2)},${height}Z` : ''

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className={cn('block w-full overflow-visible', className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {threshold !== undefined ? (
        <line
          x1="0"
          x2={W}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="var(--border-strong)"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {area ? <path d={area} fill={`url(#${gradient})`} /> : null}
      {line ? (
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  )
}
