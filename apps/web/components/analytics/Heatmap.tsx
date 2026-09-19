import type { AnalyticsHeatmapRow } from '@heli/contracts'
import { hour, percent } from '@/lib/format'

/**
 * Focus by hour of day. A cell's strength is the on-task ratio; an hour with no sessions is an
 * outline, not a zero — not working is not the same as not focusing.
 */
export function Heatmap({ rows }: { rows: AnalyticsHeatmapRow[] }) {
  const byHour = new Map(rows.map((r) => [r.hour, r.onTaskRatio]))
  const best = rows.reduce<AnalyticsHeatmapRow | null>(
    (b, r) => (!b || r.onTaskRatio > b.onTaskRatio ? r : b),
    null,
  )
  const worst = rows.reduce<AnalyticsHeatmapRow | null>(
    (w, r) => (!w || r.onTaskRatio < w.onTaskRatio ? r : w),
    null,
  )
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
        {Array.from({ length: 24 }, (_, h) => {
          const r = byHour.get(h)
          return (
            <div key={h} className="flex flex-col items-center gap-1.5">
              <div
                title={
                  r === undefined
                    ? `${hour(h)} · no sessions`
                    : `${hour(h)} · ${percent(r)} on task`
                }
                className={`relative h-12 w-full overflow-hidden rounded-xs ${r === undefined ? 'border border-dashed border-border' : 'bg-surface'}`}
              >
                {r !== undefined ? (
                  <div
                    className="absolute inset-0 bg-accent"
                    // Ratios cluster near the top; a steep curve makes 80% and 95% look different.
                    style={{ opacity: 0.12 + 0.88 * Math.pow(Math.max(0, (r - 0.5) / 0.5), 1.6) }}
                  />
                ) : null}
              </div>
              <span
                className={`tnum font-mono text-[10px] ${h % 3 === 0 ? 'text-text-faint' : 'text-transparent'}`}
              >
                {String(h).padStart(2, '0')}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-end gap-2 text-caption text-text-faint">
        <span>50%</span>
        {[0.6, 0.7, 0.8, 0.9, 1].map((r) => (
          <span key={r} className="relative size-3 overflow-hidden rounded-[3px] bg-surface">
            <span
              className="absolute inset-0 bg-accent"
              style={{ opacity: 0.12 + 0.88 * Math.pow((r - 0.5) / 0.5, 1.6) }}
            />
          </span>
        ))}
        <span>100% on task</span>
      </div>
      {best && worst && best.hour !== worst.hour ? (
        <p className="text-small text-text-muted">
          Sharpest around <span className="tnum text-text">{hour(best.hour)}</span> (
          {percent(best.onTaskRatio)}
          ). Weakest around <span className="tnum text-text">{hour(worst.hour)}</span> (
          {percent(worst.onTaskRatio)}).
        </p>
      ) : null}
    </div>
  )
}
