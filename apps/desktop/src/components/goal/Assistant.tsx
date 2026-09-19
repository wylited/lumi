import { useState } from 'react'
import { Button } from '@heli/ui'
import { draft, type Draft } from '../../lib/goals'

const EXAMPLES = [
  'Finish the algorithms problem set by 9',
  'Write 2 pages of the essay for 90 minutes',
  'Clear the 30 emails in my inbox before 11am',
]

/**
 * A sentence in, a suggested goal out. The suggestion is shown beside what it would change and
 * only lands when the user says so.
 */
export function Assistant({ onAccept }: { onAccept: (d: Draft) => void }) {
  const [text, setText] = useState('')
  const [suggestion, setSuggestion] = useState<Draft | null>(null)

  function run(sentence = text) {
    const d = draft(sentence)
    setSuggestion(d.notes.length ? d : null)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <label htmlFor="goal-sentence" className="text-small font-medium text-text">
        What are you sitting down to do?
      </label>
      <div className="flex gap-2">
        <input
          id="goal-sentence"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="Finish the algorithms problem set by 9"
          className="h-11 min-w-0 flex-1 rounded-pill border border-border-strong bg-bg px-4 text-body text-text outline-none placeholder:text-text-faint focus:border-accent focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface"
        />
        <Button onClick={() => run()} disabled={!text.trim()}>
          Draft it
        </Button>
      </div>
      {!suggestion ? (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setText(e)
                run(e)
              }}
              className="rounded-pill border border-border px-3 py-1 text-caption text-text-muted transition-colors duration-fast hover:border-border-strong hover:text-text"
            >
              {e}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4 rounded-md border border-accent/30 bg-surface-raised p-4">
          <div className="flex flex-col gap-1">
            <span className="text-label uppercase text-accent-link">Suggested</span>
            <span className="text-title-3 font-semibold text-text">
              {suggestion.patch.objective}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {suggestion.notes.map((n) => (
              <li key={n} className="flex gap-2 text-small text-text-muted">
                <span className="text-text-faint">·</span>
                {n}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                onAccept(suggestion)
                setSuggestion(null)
              }}
            >
              Use this draft
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
              Discard
            </Button>
            <span className="ml-auto text-caption text-text-faint">
              Nothing changes until you use it.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
