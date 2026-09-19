/** The desktop's logger. Nothing in the app calls `console` directly. */
type Level = 'debug' | 'info' | 'warn' | 'error'

const DEV = import.meta.env.DEV

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  if (level === 'debug' && !DEV) return
  const line = `[heli:${scope}] ${message}`
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  if (detail === undefined) sink(line)
  else sink(line, detail)
}

export function logger(scope: string) {
  return {
    debug: (m: string, d?: unknown) => write('debug', scope, m, d),
    info: (m: string, d?: unknown) => write('info', scope, m, d),
    warn: (m: string, d?: unknown) => write('warn', scope, m, d),
    error: (m: string, d?: unknown) => write('error', scope, m, d),
  }
}
