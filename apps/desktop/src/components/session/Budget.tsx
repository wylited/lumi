import type { Goal } from '@heli/contracts'
import { Meter } from '@heli/ui'
import { sessionClock } from './format'

const BREAK: Record<string, number | null> = {
  pomodoro_25_5: 25,
  pomodoro_50_10: 50,
  none: null,
  custom: null,
}

/** The goal and the clock against it. The budget is the user's, so overrun is shown, not scolded. */
export function Budget({ goal, minutes }: { goal: Goal | null; minutes: number }) {
  const budget = goal?.timeBudgetMinutes ?? null
  const every = goal ? (BREAK[goal.breakPolicy] ?? null) : null
  const nextBreak = every ? every - (minutes % (every + (every === 25 ? 5 : 10))) : null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-label uppercase text-text-faint">Goal</span>
          <h2 className="text-title-1 font-semibold text-balance text-text">
            {goal?.objective ?? 'No goal set'}
          </h2>
          {goal?.successCriteria ? (
            <p className="text-small text-text-muted">{goal.successCriteria}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="tnum font-mono text-title-2 font-medium text-text">
            {sessionClock(minutes)}
          </span>
          <span className="tnum text-caption text-text-faint">
            {budget
              ? minutes <= budget
                ? `${budget - minutes} min left of ${budget}`
                : `${minutes - budget} min over ${budget}`
              : 'no time budget'}
          </span>
        </div>
      </div>
      {budget ? (
        <Meter
          value={minutes / budget}
          tone={minutes > budget ? 'warn' : 'accent'}
          label="Time budget used"
        />
      ) : null}
      {nextBreak !== null && nextBreak > 0 ? (
        <span className="text-caption text-text-faint">
          Break in <span className="tnum text-text-muted">{nextBreak} min</span>
        </span>
      ) : null}
    </div>
  )
}
