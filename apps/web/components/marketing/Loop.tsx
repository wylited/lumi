const STEPS = [
  {
    name: 'Signal',
    body: 'A frame from the desk. The frontmost app. An idle stretch. Cheap, noisy, meaningless alone.',
  },
  {
    name: 'Aggregate',
    body: 'Folded into a one-minute window per session, so nothing reacts to a single twitch.',
  },
  {
    name: 'Assess',
    body: 'A model reads the window and returns one structured verdict: on the goal or not, and how sure.',
  },
  {
    name: 'Policy',
    body: 'Our rules decide: confidence, sustained drift, gaps between interruptions, what the goal permits.',
    ours: true,
  },
  {
    name: 'Act',
    body: 'Silence, the tray, a notification, a spoken line, or a reversible change to the machine.',
  },
  {
    name: 'Outcome',
    body: 'Did you come back within two minutes? Recorded either way. That record tunes the policy.',
  },
]

export function Loop() {
  return (
    <div className="relative">
      <ol className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-6">
        {STEPS.map((s, i) => (
          <li
            key={s.name}
            className={`flex flex-col gap-3 p-5 ${s.ours ? 'bg-accent-wash' : 'bg-bg'}`}
          >
            <span className="flex items-center justify-between">
              <span className="tnum font-mono text-[11px] text-text-faint">0{i + 1}</span>
              {i < STEPS.length - 1 ? (
                <span aria-hidden="true" className="hidden text-text-faint lg:inline">
                  →
                </span>
              ) : (
                <span aria-hidden="true" className="hidden text-accent lg:inline">
                  ↺
                </span>
              )}
            </span>
            <span
              className={`text-body-strong font-semibold ${s.ours ? 'text-accent-link' : 'text-text'}`}
            >
              {s.name}
            </span>
            <p className="text-small text-text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-small text-text-faint">
        The model only ever proposes. It never writes to a notification, a speaker or the machine —
        step 04 does, and only when the evidence and your goal allow it.
      </p>
    </div>
  )
}
