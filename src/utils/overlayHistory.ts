// Back closes the topmost overlay in the mobile layout (Android's back gesture is WebView
// history back).
//
// While enabled, every dialog and drawer registered through pushLayer() owns one history
// entry at the page's own URL, pushed through the router's history so its
// positions stay consistent and no route change happens. Back pops that entry, and the
// popstate closes the overlays whose entries lay above the new position through their
// Escape handlers. An overlay that stays open (a discard prompt) gets a new entry.
//
// An overlay closed any other way drops its entry with go(-1) when that entry is the
// current one, with router listeners paused. A navigation that starts on an overlay entry
// first drops the overlay entries, so the new route takes their place in history and Back
// from it returns to the page under them. Overlays still open after that navigation get a
// new entry on the new route.
//
// history.go() is asynchronous: pushes and navigations wait for the popstates of pending
// go() calls.

import { nextTick } from 'vue'
import type { Router, RouterHistory } from 'vue-router'
import { setLayerHistory, type LayerKind } from '@/utils/a11y/layers'

/** history.state key of an overlay entry; the value is `<session>:<id>`. */
export const OVERLAY_STATE_KEY = 'harmonyOverlay'

// Menus and popovers get no entry: they open and close far more often, and Safari limits
// pushState/replaceState calls (100 per 30 s, after which vue-router reloads the page).
const KINDS: ReadonlySet<LayerKind> = new Set<LayerKind>(['dialog', 'drawer'])
// A go() whose popstate never arrives (traversal refused) must not hold pushes and
// navigations forever.
const SETTLE_TIMEOUT_MS = 600
// Keys of an earlier page load in the same tab never match this load's overlays.
const SESSION = Math.random().toString(36).slice(2, 8)

interface Entry {
  key: string
  /** history.state.position of the overlay's entry; 0 until pushed. */
  position: number
  /** The overlay's entry is not in the history stack (popped, dropped or not yet pushed). */
  detached: boolean
  close: () => void
  isOpen: () => boolean
}

let routerHistory: RouterHistory | null = null
let enabled: () => boolean = () => false
let entries: Entry[] = []
let nextId = 1
let pendingPops = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null
let afterSettle: Array<() => void> = []
let droppedByNavigation: Entry[] = []

function currentState(): Record<string, unknown> | null {
  const state = typeof window !== 'undefined' ? window.history.state : null
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : null
}

function positionOf(state: unknown): number {
  const position = (state as { position?: unknown } | null)?.position
  return typeof position === 'number' ? position : 0
}

function finishPops(): void {
  pendingPops = 0
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
  const run = afterSettle
  afterSettle = []
  run.forEach((fn) => fn())
}

function whenSettled(fn: () => void): void {
  if (pendingPops === 0) fn()
  else afterSettle.push(fn)
}

function settled(): Promise<void> {
  return new Promise((resolve) => whenSettled(resolve))
}

/**
 * Resolves once closed overlays' entries are gone: after Vue's pending flush (a dialog
 * releases its layer in a post-flush watcher) and the popstates of the go() calls that drop
 * them. A drop deferred behind another pop starts when that one settles, hence the loop.
 */
export async function overlayHistorySettled(): Promise<void> {
  await nextTick()
  while (pendingPops > 0) await settled()
}

/** Goes back `count` entries with router listeners paused. */
function popEntries(count: number): void {
  if (!routerHistory || count <= 0) return
  pendingPops++
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(finishPops, SETTLE_TIMEOUT_MS)
  routerHistory.go(-count, false)
}

function pushEntry(entry: Entry): void {
  if (!routerHistory || !entries.includes(entry) || !entry.isOpen()) return
  routerHistory.push(routerHistory.location, { [OVERLAY_STATE_KEY]: entry.key })
  entry.position = positionOf(routerHistory.state)
  entry.detached = false
}

function attach(entry: Entry): void {
  entry.detached = true
  entry.position = 0
  whenSettled(() => pushEntry(entry))
}

/** Drops `entry`'s history entry when it is the current one. */
function dropIfCurrent(entry: Entry): void {
  const state = currentState()
  if (!routerHistory || !state || state[OVERLAY_STATE_KEY] !== entry.key || positionOf(state) !== entry.position) return
  // A router.replace while the overlay was open changed this entry's URL; the entry under
  // it keeps the old one.
  const url = routerHistory.location
  popEntries(1)
  afterSettle.push(() => {
    if (routerHistory && routerHistory.location !== url) routerHistory.replace(url)
  })
}

function release(entry: Entry): void {
  const i = entries.indexOf(entry)
  if (i < 0) return
  entries.splice(i, 1)
  const wasAttached = !entry.detached && entry.position > 0
  entry.detached = true
  if (wasAttached) whenSettled(() => dropIfCurrent(entry))
}

function register(layer: { kind: LayerKind; close: () => void; isOpen: () => boolean }): (() => void) | undefined {
  if (!routerHistory || !KINDS.has(layer.kind) || !enabled()) return undefined
  const entry: Entry = {
    key: `${SESSION}:${nextId++}`,
    position: 0,
    detached: true,
    close: layer.close,
    isOpen: layer.isOpen,
  }
  entries.push(entry)
  attach(entry)
  return () => release(entry)
}

function onPopState(event: PopStateEvent): void {
  if (pendingPops > 0) {
    pendingPops--
    if (pendingPops === 0) finishPops()
    return
  }
  const position = positionOf(event.state)
  const popped = entries.filter((e) => !e.detached && e.position > position).reverse()
  if (!popped.length) return
  popped.forEach((e) => {
    e.detached = true
  })
  popped.forEach((e) => e.close())
  // Close handlers run through component state; check after Vue has flushed.
  setTimeout(() => {
    for (const e of [...popped].reverse()) if (entries.includes(e) && e.isOpen()) attach(e)
  }, 0)
}

/** Overlay entries from the current one down to the page entry under them. */
function overlayDepth(): number {
  const state = currentState()
  if (!state || typeof state[OVERLAY_STATE_KEY] !== 'string') return 0
  const top = positionOf(state)
  const below = entries.filter((e) => !e.detached && e.position > 0 && e.position <= top).map((e) => e.position)
  const lowest = below.length ? Math.min(...below) : top
  return top - lowest + 1
}

async function beforeNavigation(to: { fullPath: string }, from: { fullPath: string }): Promise<true> {
  if (!routerHistory || to.fullPath === from.fullPath) return true
  // On a popstate the router's location already is the destination.
  if (routerHistory.location === to.fullPath) return true
  await settled()
  const depth = overlayDepth()
  if (depth > 0) {
    const top = positionOf(currentState())
    const dropped = entries.filter((e) => !e.detached && e.position > top - depth)
    dropped.forEach((e) => {
      e.detached = true
    })
    droppedByNavigation.push(...dropped)
    popEntries(depth)
    await settled()
  }
  return true
}

function afterNavigation(): void {
  const dropped = droppedByNavigation
  droppedByNavigation = []
  if (!dropped.length) return
  // Overlays that outlive the route change (closing on it happens in watchers) get an
  // entry on the new route.
  setTimeout(() => {
    for (const e of dropped) if (entries.includes(e) && e.isOpen()) attach(e)
  }, 0)
}

/** Gives every dialog and drawer opened while `isEnabled()` a Back entry. */
export function installOverlayHistory(router: Router, isEnabled: () => boolean): () => void {
  routerHistory = router.options.history
  enabled = isEnabled
  window.addEventListener('popstate', onPopState)
  const removeBefore = router.beforeEach(beforeNavigation)
  const removeAfter = router.afterEach(afterNavigation)
  setLayerHistory(register)
  return () => {
    window.removeEventListener('popstate', onPopState)
    removeBefore()
    removeAfter()
    setLayerHistory(null)
    routerHistory = null
    enabled = () => false
    entries = []
    pendingPops = 0
    afterSettle = []
    droppedByNavigation = []
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }
}
