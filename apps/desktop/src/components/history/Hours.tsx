import type { AnalyticsHeatmapRow } from '@heli/contracts'

/** 24 cells. Strength is the on-task share; an hour you did not work is an outline, not a zero. */
export function Hours({ rows }: { rows: AnalyticsHeatmapRow[] }) {
  const by = new Map(rows.map((r) => [r.hour, r.onTaskRatio]))
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
        {Array.from({ length: 24 }, (_, h) => {
          const r = by.get(h)
          return (
            <div
              key={h}
              title={
                r === undefined
                  ? `${h}:00 · no sessions`
                  : `${h}:00 · ${Math.round(r * 100)}% on task`
              }
              className={`relative h-9 overflow-hidden rounded-[4px] ${r === undefined ? 'border border-dashed border-border' : 'bg-surface'}`}
            >
              {r !== undefined ? (
                <span
                  className="absolute inset-0 bg-accent"
                  style={{ opacity: 0.12 + 0.88 * Math.pow(Math.max(0, (r - 0.5) / 0.5), 1.6) }}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      <div
        className="grid font-mono text-[10px] text-text-faint"
        style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="tnum">
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
