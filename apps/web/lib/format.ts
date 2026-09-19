/** Numbers are the product. Every figure on screen goes through one of these. */

export function minutes(value: number): string {
  if (value < 1) return value === 0 ? '0' : '<1'
  if (value < 60) return String(Math.round(value))
  const h = Math.floor(value / 60)
  const m = Math.round(value % 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m${seconds % 60 >= 30 && m < 10 ? ` ${Math.round(seconds % 60)}s` : ''}`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function day(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function relative(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

export function hour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}
