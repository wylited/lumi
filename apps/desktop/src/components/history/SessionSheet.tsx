import { useEffect, useState } from 'react'
import type { SessionDetail } from '@heli/contracts'
import { Sheet } from '@heli/ui'
import { api } from '../../lib/api'
import { Figure } from '../kit'
import { Actions } from '../session/Actions'
import { clock, mm } from '../session/format'
import { Ribbon } from '../session/Ribbon'

export function SessionSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [s, setS] = useState<SessionDetail | null>(null)
  useEffect(() => {
    setS(null)
    if (id) void api.session(id).then(setS)
  }, [id])

  const title = s
    ? `${new Date(s.startedAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}, ${clock(s.startedAt)}`
    : 'Session'
  return (
    <Sheet open={id !== null} onClose={onClose} title={title}>
      {!s ? null : (
        <div className="flex flex-col gap-8">
          <p className="text-body-strong font-semibold text-text">{s.goal?.objective}</p>
          <Ribbon observations={s.observations} />
          {s.summary ? (
            <div className="flex gap-10">
              <Figure value={mm(s.summary.focusedMinutes * 60)} label="Focused" />
              <Figure value={mm(s.summary.offTaskMinutes * 60)} label="Off task" />
              <Figure value={mm(s.summary.longestFocusRunSeconds)} label="Longest run" />
            </div>
          ) : null}
          <section className="flex flex-col gap-1">
            <h3 className="text-body-strong font-semibold text-text">Interruptions</h3>
            <Actions observations={s.observations} empty="None." />
          </section>
        </div>
      )}
    </Sheet>
  )
}
