// Overlay layers: one Escape stack, background inertness and scroll locking
// shared by every dialog, drawer and menu.
//
// Escape stack
//   pushLayer() registers an open overlay; the last one pushed is topmost. One
//   window keydown listener (bubble phase) hands Escape to the topmost layer
//   only, then stops it. It does nothing when:
//   - the event was already defaultPrevented (a widget inside consumed it),
//   - focus is outside the topmost layer's element (an unregistered popup
//     opened from it owns that Escape); focus stranded on an element this
//     module made inert counts as inside, since nothing there takes keys,
//   - the topmost layer opened while this keydown was being dispatched (a
//     view's own Escape listener opened it, e.g. a discard-changes prompt),
//   - focus is on an expanded combobox or text field (aria-expanded="true"),
//     whose listbox closes first.
//   Widgets inside a layer that close themselves on Escape call
//   event.preventDefault() to keep the layer open.
//
// Inertness
//   inertOthers(roots) sets `inert` on every sibling of every ancestor of the
//   roots, up to <body>, and returns its release. Counts are kept per element,
//   so stacked dialogs release in any order; an element that carried `inert`
//   before is never touched. Elements appended later (popovers teleported from
//   inside a dialog) stay interactive. PERSISTENT_SELECTOR elements (live
//   regions, the toast host) are never made inert: an inert live region is
//   silent.

export type LayerKind = 'dialog' | 'drawer' | 'menu' | 'popover'

export interface LayerOptions {
  kind: LayerKind
  /** The layer's element; Escape outside it is ignored. */
  element: () => Element | null | undefined
  /** Called for Escape while topmost. */
  onEscape: () => void
}

interface Layer extends LayerOptions {
  id: number
}

const layers: Layer[] = []
let nextId = 1
let listening = false
// Id of the topmost layer when the current keydown entered the window (capture phase).
let topIdAtDispatch = 0

const EXPANDED_FIELD =
  'input[aria-expanded="true"], textarea[aria-expanded="true"], [role="combobox"][aria-expanded="true"], [contenteditable="true"][aria-expanded="true"]'

function onKeydownCapture(): void {
  topIdAtDispatch = layers[layers.length - 1]?.id ?? 0
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
  const top = layers[layers.length - 1]
  if (!top || top.id > topIdAtDispatch) return
  const root = top.element()
  const target = event.target
  if (
    root &&
    target instanceof Node &&
    target !== document.body &&
    target !== document.documentElement &&
    !root.contains(target) &&
    !isInManagedInert(target)
  )
    return
  if (target instanceof Element && target !== root && target.closest(EXPANDED_FIELD)) return
  event.preventDefault()
  event.stopPropagation()
  top.onEscape()
}

/** Registers an open overlay; returns its removal. */
export function pushLayer(options: LayerOptions): () => void {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeydownCapture, true)
    window.addEventListener('keydown', onKeydown)
    listening = true
  }
  const layer: Layer = { ...options, id: nextId++ }
  layers.push(layer)
  return () => {
    const i = layers.indexOf(layer)
    if (i >= 0) layers.splice(i, 1)
  }
}

/** True when `element` is the topmost layer's element. */
export function isTopLayerElement(element: Element | null | undefined): boolean {
  const top = layers[layers.length - 1]
  return !!top && !!element && top.element() === element
}

/** True while any dialog, drawer or menu is registered. */
export function hasOpenLayer(kind?: LayerKind): boolean {
  return kind ? layers.some((l) => l.kind === kind) : layers.length > 0
}

/** Top-level elements that never become inert. */
export const PERSISTENT_SELECTOR = '[data-a11y-persistent], .Vue-Toastification__container, script, style, link, template, noscript'

const inertCounts = new Map<Element, number>()
const preexisting = new WeakSet<Element>()

function hold(el: Element): void {
  const count = inertCounts.get(el) ?? 0
  if (count === 0) {
    if (el.hasAttribute('inert')) preexisting.add(el)
    else el.setAttribute('inert', '')
  }
  inertCounts.set(el, count + 1)
}

function release(el: Element): void {
  const count = inertCounts.get(el)
  if (!count) return
  if (count > 1) {
    inertCounts.set(el, count - 1)
    return
  }
  inertCounts.delete(el)
  if (preexisting.has(el)) preexisting.delete(el)
  else el.removeAttribute('inert')
}

/** Makes `el` inert until the returned release runs; counted like inertOthers. */
export function holdInert(el: Element): () => void {
  hold(el)
  let released = false
  return () => {
    if (released) return
    released = true
    release(el)
  }
}

/** Makes everything outside `roots` inert; returns the release. */
export function inertOthers(roots: Element[]): () => void {
  if (typeof document === 'undefined') return () => {}
  const keep = new Set<Element>()
  for (const root of roots) {
    let node: Element | null = root
    while (node && node !== document.body && node !== document.documentElement) {
      keep.add(node)
      node = node.parentElement
    }
  }
  const applied = new Set<Element>()
  for (const root of roots) {
    let node: Element | null = root
    while (node && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement
      if (!parent) break
      for (const sibling of Array.from(parent.children)) {
        if (keep.has(sibling) || applied.has(sibling) || sibling.matches(PERSISTENT_SELECTOR)) continue
        hold(sibling)
        applied.add(sibling)
      }
      node = parent
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    applied.forEach(release)
  }
}

/** True when `node` sits inside an element made inert by this module. */
export function isInManagedInert(node: Node): boolean {
  for (const el of inertCounts.keys()) if (el.contains(node)) return true
  return false
}

let scrollLocks = 0
let savedOverflow = ''

/** Sets overflow:hidden on <body> until the last lock is released. */
export function lockScroll(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks++
  let released = false
  return () => {
    if (released) return
    released = true
    scrollLocks--
    if (scrollLocks === 0) document.body.style.overflow = savedOverflow
  }
}

// Menu element -> the trigger focused when it opened. A dialog opened from a
// menu item restores focus to the trigger once the menu has unmounted.
const menuTriggers = new WeakMap<Element, HTMLElement>()

export function setMenuTrigger(menu: Element, trigger: HTMLElement | null): void {
  if (trigger) menuTriggers.set(menu, trigger)
}

/** The button that opened `popup` and reports it expanded, for popups not built on useMenu. */
function expandedOwnerOf(popup: Element): HTMLElement | null {
  if (popup.id) {
    const controller = document.querySelector<HTMLElement>(`[aria-controls~="${CSS.escape(popup.id)}"]`)
    if (controller) return controller
  }
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]'),
  ).filter((el) => !popup.contains(el))
  return candidates.find((el) => el.parentElement?.contains(popup)) ?? candidates[candidates.length - 1] ?? null
}

/**
 * For an element inside an open menu, that menu's trigger (registered by
 * useMenu, else the expanded aria-haspopup button that owns it); else the
 * element.
 */
export function resolveFocusOrigin(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  const POPUP = '[role="menu"], [role="menubar"], [role="listbox"]'
  let menu = el.closest(POPUP)
  while (menu) {
    const trigger = menuTriggers.get(menu) ?? expandedOwnerOf(menu)
    if (trigger && trigger !== el) return resolveFocusOrigin(trigger)
    menu = menu.parentElement?.closest(POPUP) ?? null
  }
  return el
}

/** Test hook: drops every layer, inert hold and scroll lock. */
export function resetLayersForTests(): void {
  layers.length = 0
  for (const el of Array.from(inertCounts.keys())) {
    if (!preexisting.has(el)) el.removeAttribute('inert')
  }
  inertCounts.clear()
  if (scrollLocks > 0 && typeof document !== 'undefined') document.body.style.overflow = savedOverflow
  scrollLocks = 0
}
