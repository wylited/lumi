import type { AnalyticsHeatmapRow } from '@heli/contracts'

/** Share on the goal, by hour of day. An hour you never worked is blank, not zero. */
export function Hours({ rows }: { rows: AnalyticsHeatmapRow[] }) {
  const by = new Map(rows.map((r) => [r.hour, r.onTaskRatio]))
  const cols = { gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-[3px]" style={cols}>
        {Array.from({ length: 24 }, (_, h) => {
          const r = by.get(h)
          return (
            <span
              key={h}
              title={
                r === undefined
                  ? `${h}:00 · no sessions`
                  : `${h}:00 · ${Math.round(r * 100)}% on the goal`
              }
              className="relative h-8 overflow-hidden rounded-[3px] bg-ink-100/60"
            >
              {r !== undefined ? (
                <span
                  className="absolute inset-0 bg-accent"
                  style={{ opacity: 0.15 + 0.85 * Math.max(0, (r - 0.5) / 0.5) ** 1.6 }}
                />
              ) : null}
            </span>
          )
        })}
      </div>
      <div className="grid text-caption text-text-faint" style={cols}>
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="tnum">
            {h % 6 === 0 ? `${h}:00` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
