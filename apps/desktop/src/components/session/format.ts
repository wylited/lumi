export function mins(n: number): string {
  return n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n))
}

export function dur(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return s && m < 10 ? `${m}m ${s}s` : `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** mm:ss from windows, where one window is one minute of session time. */
export function sessionClock(windows: number): string {
  const h = Math.floor(windows / 60)
  const m = windows % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:00` : `${String(m).padStart(2, '0')}:00`
}
