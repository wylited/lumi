/** Durations and clocks, the way the screens say them. */

export function dur(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** A goal in the person's own words, quoted once: a goal that already carries quotes is not wrapped again. */
export function quoted(goal: string): string {
  return /["“”]/.test(goal) ? goal : `“${goal}”`
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function greeting(now: Date): string {
  const h = now.getHours()
  const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 22 ? 'Evening' : 'Late night'
  return `${now.toLocaleDateString([], { weekday: 'long' })} · ${part}`
}
