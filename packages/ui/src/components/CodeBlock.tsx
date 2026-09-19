'use client'

import { useState } from 'react'
import { cn } from '../cn'

export interface CodeBlockProps {
  code: string
  language?: 'python' | 'json' | 'text'
  /** Optional trailing annotation, e.g. an execution result. */
  result?: string
  resultTone?: 'neutral' | 'danger'
  className?: string
}

const STRING_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g

/** Highlight strings only — one accent, no library. Everything else is text. */
function highlight(code: string) {
  return code.split(STRING_RE).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="text-accent-link">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

export function CodeBlock({ code, result, resultTone = 'neutral', className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-md border border-border bg-surface',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }}
        className={cn(
          'absolute right-3 top-3 rounded-pill border border-border bg-surface-raised px-2.5 py-1',
          'font-mono text-[11px] text-text-faint opacity-0 transition-opacity duration-base ease-heli',
          'hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'group-hover:opacity-100',
          copied && 'opacity-100 text-accent-link',
        )}
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="overflow-x-auto p-4 pr-16 font-mono text-mono leading-relaxed text-text">
        <code>{highlight(code)}</code>
      </pre>
      {result ? (
        <div
          className={cn(
            'border-t border-border px-4 py-2 font-mono text-mono',
            resultTone === 'danger' ? 'text-danger' : 'text-text-muted',
          )}
        >
          <span className="select-none text-text-faint">→ </span>
          {result}
        </div>
      ) : null}
    </div>
  )
}
