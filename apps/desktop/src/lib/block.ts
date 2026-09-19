/**
 * Blocking, during a session, for a goal that allows "Change my machine".
 *
 * Two sources decide what is blocked, and one path carries it out:
 *   - the goal's own lists (`blockedApps`, `blockedSites`), enforced the moment the thing comes to
 *     the front — no model, no wait;
 *   - the loop's tier 4 (`lib/socket` hands `automation` messages here): the model judged the
 *     front app or site off the goal, and it stays blocked for the rest of the session.
 *
 * A blocked app is hidden, never quit. A blocked tab is sent to a local page that says why, and
 * the URL it was on is kept. Every block raises a banner and an in-app card with Undo; undoing
 * restores it and leaves that app or site alone for ten minutes. Each block and undo is recorded as
 * a signal, so the history shows what was changed and whether it was taken back.
 */
import { useSyncExternalStore } from 'react'
import type { Goal, Signal } from '@heli/contracts'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { live } from './live'
import { logger } from './log'
import { native } from './native'
import { banner } from './notify'
import { desktopSocket } from './socket'

const log = logger('block')
const EXEMPT_MS = 10 * 60_000
const SELF = 'app.lumi.desktop'
const TAB_POLL_MS = 3000

export interface Blocked {
  id: string
  kind: 'app' | 'site'
  /** What the person sees: "Discord", "instagram.com". */
  target: string
  why: 'goal' | 'lumi'
  undo: () => Promise<void>
}

let current: Blocked | null = null
const listeners = new Set<() => void>()
function show(next: Blocked | null) {
  current = next
  listeners.forEach((l) => l())
}

/** Sites and apps the loop blocked this session, keyed by session. */
let muted: { sessionId: string; sites: Set<string>; apps: Set<string> } | null = null
/** Undone targets, left alone until the time stored. */
const exempt = new Map<string, number>()
/** The front app, from the last `app.frontmost`. */
let front: { bundleId: string; name: string; pid: number } | null = null
let checking = false

/** "https://www.Instagram.com/reels" and "instagram.com" both become "instagram.com". */
export function hostOf(s: string): string {
  const t = s.trim().toLowerCase()
  try {
    return new URL(t.includes('://') ? t : `https://${t}`).hostname.replace(/^www\./, '')
  } catch {
    return t.replace(/^www\./, '').split('/')[0] ?? ''
  }
}

function siteMatches(host: string, entry: string): boolean {
  const e = hostOf(entry)
  return !!e && (host === e || host.endsWith(`.${e}`))
}

function appMatches(app: { bundleId: string; name: string }, entry: string): boolean {
  const e = entry.trim().toLowerCase()
  return !!e && (app.name.toLowerCase() === e || app.bundleId.toLowerCase() === e)
}

/** The goal, when the session is live and the goal allows changing the machine. */
function enforcing(): { goal: Goal; sessionId: string } | null {
  const snap = live.get()
  const goal = snap.goal
  if (snap.status !== 'live' || !snap.session || !goal) return null
  if (!goal.permissions.includes('automate')) return null
  return { goal, sessionId: snap.session.id }
}

function mutedFor(sessionId: string) {
  if (muted?.sessionId !== sessionId) muted = { sessionId, sites: new Set(), apps: new Set() }
  return muted
}

function isExempt(key: string): boolean {
  const until = exempt.get(key)
  if (until === undefined) return false
  if (Date.now() < until) return true
  exempt.delete(key)
  return false
}

function record(kind: 'automation.applied' | 'automation.undone', payload: Signal['payload']) {
  native.record({ source: 'system', kind, ts: new Date().toISOString(), confidence: 1, payload })
}

async function blockApp(app: { bundleId: string; name: string; pid: number }, goal: Goal, why: Blocked['why']) {
  const key = `app:${app.bundleId}`
  if (isExempt(key) || !(await invoke<boolean>('hide_app', { pid: app.pid }))) return
  log.info(`hid ${app.name} (${why})`)
  record('automation.applied', { action: 'hide_app', target: app.name, why })
  void banner(`Lumi hid ${app.name}. It is off the list for “${goal.objective}”. Undo it in Lumi.`)
  show({
    id: `${Date.now()}`,
    kind: 'app',
    target: app.name,
    why,
    undo: async () => {
      exempt.set(key, Date.now() + EXEMPT_MS)
      await invoke('unhide_app', { pid: app.pid })
      record('automation.undone', { action: 'hide_app', target: app.name, why })
      show(null)
    },
  })
}

async function blockTab(bundleId: string, url: string, host: string, goal: Goal, why: Blocked['why']) {
  const key = `site:${host}`
  if (isExempt(key)) return
  const page = await invoke<string>('blocked_page', { site: host, goal: goal.objective })
  await invoke('browser_navigate', { bundleId, url: page })
  log.info(`moved a tab off ${host} (${why})`)
  record('automation.applied', { action: 'navigate_tab', target: host, why })
  void banner(`Lumi moved a tab off ${host}. It is off the list for “${goal.objective}”. Undo it in Lumi.`)
  show({
    id: `${Date.now()}`,
    kind: 'site',
    target: host,
    why,
    undo: async () => {
      exempt.set(key, Date.now() + EXEMPT_MS)
      await invoke('browser_navigate', { bundleId, url })
      record('automation.undone', { action: 'navigate_tab', target: host, why })
      show(null)
    },
  })
}

/** Look at the front browser tab and block it if it is on a list. One check at a time. */
async function checkTab(bundleId: string) {
  const on = enforcing()
  if (!on || checking) return
  checking = true
  try {
    const url = await invoke<string>('browser_url', { bundleId })
    if (!/^https?:/i.test(url)) return
    const host = hostOf(url)
    const m = mutedFor(on.sessionId)
    const byGoal = on.goal.blockedSites.some((e) => siteMatches(host, e))
    const byLumi = [...m.sites].some((e) => siteMatches(host, e))
    if (byGoal || byLumi) await blockTab(bundleId, url, host, on.goal, byGoal ? 'goal' : 'lumi')
  } catch (error) {
    // No Automation grant, no window, or Firefox: the tab stays, and the log says why.
    log.debug('tab not checked', String(error))
  } finally {
    checking = false
  }
}

function onSignal(s: Signal) {
  if (s.kind === 'app.frontmost') {
    const p = s.payload
    front = { bundleId: String(p.bundleId ?? ''), name: String(p.name ?? ''), pid: Number(p.pid ?? 0) }
  }
  const on = enforcing()
  if (!on || !front || front.bundleId === SELF) return

  if (s.kind === 'app.frontmost') {
    const m = mutedFor(on.sessionId)
    const byGoal = on.goal.blockedApps.some((e) => appMatches(front!, e))
    const byLumi = [...m.apps].some((e) => appMatches(front!, e))
    if (byGoal || byLumi) {
      void blockApp(front, on.goal, byGoal ? 'goal' : 'lumi')
      return
    }
  }
  // A browser came to the front, or its tab's title changed: read the real URL.
  if ((s.kind === 'app.frontmost' || s.kind === 'window.title') && isBrowserFront()) {
    void checkTab(front.bundleId)
  }
}

const BROWSERS = new Set([
  'com.apple.Safari',
  'com.google.Chrome',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'com.microsoft.edgemac',
  'com.operasoftware.Opera',
])
function isBrowserFront() {
  return !!front && BROWSERS.has(front.bundleId)
}

export const block = {
  /** Start enforcing. Returns the unhook. A no-op outside the desktop app. */
  attach(): () => void {
    if (!isTauri()) return () => {}
    const unhook = native.onSignal(onSignal)
    const unhookLoop = desktopSocket.onAutomation((a) => {
      void block.fromLoop(a.action, a.target).then((done) => {
        if (!done) log.info(`tier 4 ${a.action} on ${a.target ?? 'the front app'}: nothing to change`)
      })
    })
    // A tab can change site without a new title reaching us (no Screen Recording, or the same
    // title): while a browser is in front, look at its tab every few seconds too.
    const poll = setInterval(() => {
      if (front && isBrowserFront()) void checkTab(front.bundleId)
    }, TAB_POLL_MS)
    return () => {
      unhook()
      unhookLoop()
      clearInterval(poll)
    }
  },

  /**
   * The loop's tier 4: block what is in front now, and keep it blocked for the session.
   * Returns whether anything was blocked.
   */
  async fromLoop(action: string, target: string | null): Promise<boolean> {
    const on = enforcing()
    if (!on || !front || front.bundleId === SELF) return false
    if (action !== 'mute_site' && action !== 'navigate_tab') {
      log.info(`loop asked for ${action}; the desktop does not carry it out`)
      return false
    }
    const m = mutedFor(on.sessionId)
    if (BROWSERS.has(front.bundleId)) {
      // A site target acts on the tab. A browser itself is never hidden: it is where the work is too.
      const bundleId = front.bundleId
      const url = await invoke<string>('browser_url', { bundleId }).catch(() => '')
      if (!/^https?:/i.test(url)) return false
      const host = hostOf(url)
      if (target && !siteMatches(host, target)) return false
      m.sites.add(host)
      await blockTab(bundleId, url, host, on.goal, 'lumi')
      return true
    }
    if (target && !appMatches(front, target)) return false
    m.apps.add(front.name)
    await blockApp(front, on.goal, 'lumi')
    return true
  },

  get: () => current,
  dismiss: () => show(null),
}

export function useBlocked(): Blocked | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  )
}
