/**
 * Call pop-out: the call view moves into a second window of the same JS
 * context, so the call keeps its connection, stores and media elements. The
 * window is a Document Picture-in-Picture window where the browser has one,
 * else window.open('about:blank') (a native window on the desktop app; see
 * src-tauri/src/popout.rs).
 *
 * The pop-out document holds two containers, in paint order: the call view
 * (UnifiedVoiceOverlay's Teleport, popups included) and the activity player
 * (ActivityHost). Its <head> mirrors every stylesheet of the main document,
 * including ones added later; its <html> mirrors the main <html> attributes
 * (theme, skin, zoom variables).
 *
 * Code still runs in the main realm, so listeners on the main document and
 * window do not hear input in the pop-out. Keyboard, pointer, click and focus
 * events of the pop-out are re-dispatched on the main document with their
 * original target: shortcuts, outside-click dismissal, Escape layers and the
 * desktop link handler keep working, and a preventDefault there reaches the
 * original event.
 */

import { computed, nextTick, shallowReactive, shallowReadonly } from 'vue'
import { isTauriRuntime } from '@/services/instanceConfig'
import { isMobileUserAgent } from '@/utils/platform'
import { setPauseVideoInBackground } from '@/services/voice/adaptiveStreamSettings'
import { debug } from '@/utils/debug'

export type CallPopoutKind = 'pip' | 'window'

/** window.open name. The desktop shell opens a window for about:blank only (src-tauri/src/popout.rs). */
export const CALL_POPOUT_NAME = 'harmony-call'

export const CALL_POPOUT_IDS = {
  root: 'call-popout-root',
  activity: 'call-popout-activity',
} as const

/** CSS px. */
export const CALL_POPOUT_DEFAULT_SIZE = { width: 1024, height: 640 } as const

// Close and a replaced document (followDocument) are also polled for.
const POLL_MS = 500

interface CallPopoutState {
  window: Window | null
  kind: CallPopoutKind | null
  root: HTMLElement | null
  activity: HTMLElement | null
  /** Bumps whenever the containers change: subtrees bound to a document's realm key on it. */
  generation: number
}

const state = shallowReactive<CallPopoutState>({
  window: null,
  kind: null,
  root: null,
  activity: null,
  generation: 0,
})

export const callPopout = shallowReadonly(state)
export const callPopoutActive = computed(() => state.window !== null)

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
}

function documentPip(win: Window): DocumentPictureInPicture | null {
  return ((win as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture) ?? null
}

/**
 * False on phones and tablets (the Android and iOS apps have neither a second
 * window nor Document PiP).
 */
export function callPopoutSupported(win: Window = window): boolean {
  if (isMobileUserAgent()) return false
  return !!documentPip(win) || typeof win.open === 'function'
}

// ---- document mirroring ------------------------------------------------------------------

function isStyleNode(node: Node): node is HTMLStyleElement | HTMLLinkElement {
  if (node.nodeName === 'STYLE') return true
  return node.nodeName === 'LINK' && /\bstylesheet\b/i.test((node as HTMLLinkElement).rel)
}

function syncAttributes(from: Element, to: Element, keep: (name: string) => boolean = () => false): void {
  for (const attr of Array.from(to.attributes)) {
    if (!from.hasAttribute(attr.name) && !keep(attr.name)) to.removeAttribute(attr.name)
  }
  for (const attr of Array.from(from.attributes)) {
    if (to.getAttribute(attr.name) !== attr.value) to.setAttribute(attr.name, attr.value)
  }
}

/**
 * Copies `src`'s stylesheets (<link rel=stylesheet>, <style>) into `dst`'s
 * <head> in document order and keeps them in step: added, removed and edited
 * sheets follow, as Vite's dev server and lazy chunks add them. The <html>
 * attributes follow too. Returns the stop function; the copies stay.
 */
export function mirrorDocument(src: Document, dst: Document): () => void {
  const copies = new Map<Node, Element>()

  const insertCopy = (node: HTMLStyleElement | HTMLLinkElement) => {
    if (copies.has(node)) return
    const clone = dst.importNode(node, true) as Element
    copies.set(node, clone)
    let next: Node | null = node.nextSibling
    while (next && !copies.has(next)) next = next.nextSibling
    const before = next ? copies.get(next)! : null
    dst.head.insertBefore(clone, before && before.parentNode === dst.head ? before : null)
  }

  const removeCopy = (node: Node) => {
    const clone = copies.get(node)
    if (!clone) return
    clone.remove()
    copies.delete(node)
  }

  const refreshCopy = (node: Node) => {
    const clone = copies.get(node)
    if (!clone) return
    if (node.nodeName === 'STYLE') {
      if (clone.textContent !== node.textContent) clone.textContent = node.textContent
    } else {
      syncAttributes(node as Element, clone)
    }
  }

  for (const node of Array.from(src.head.childNodes)) {
    if (isStyleNode(node)) insertCopy(node)
  }
  syncAttributes(src.documentElement, dst.documentElement)

  const styleOwner = (node: Node | null): Node | null => {
    for (let n = node; n && n !== src.head; n = n.parentNode) {
      if (copies.has(n)) return n
    }
    return null
  }

  const headObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === src.head && record.type === 'childList') {
        record.removedNodes.forEach(removeCopy)
        record.addedNodes.forEach((node) => {
          if (isStyleNode(node)) insertCopy(node)
        })
        continue
      }
      const owner = styleOwner(record.target)
      if (owner) refreshCopy(owner)
    }
  })
  headObserver.observe(src.head, { childList: true, subtree: true, characterData: true, attributes: true })

  const htmlObserver = new MutationObserver(() => syncAttributes(src.documentElement, dst.documentElement))
  htmlObserver.observe(src.documentElement, { attributes: true })

  return () => {
    headObserver.disconnect()
    htmlObserver.disconnect()
  }
}

// ---- event forwarding --------------------------------------------------------------------

export const FORWARDED_EVENTS = [
  'keydown',
  'keyup',
  'pointerdown',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'contextmenu',
  'focusin',
  'focusout',
] as const

type EventCtor = new (type: string, init?: object) => Event

/**
 * Re-dispatches `from`'s input events on `to` after they bubble through the
 * pop-out. The copy is built in `to`'s realm from the original's fields;
 * target and composedPath() report the original's. A copy whose default is
 * prevented prevents the original.
 */
export function forwardEvents(from: Window, to: Document): () => void {
  const realm = to.defaultView as unknown as Record<string, EventCtor> | null
  if (!realm) return () => {}

  const relay = (event: Event) => {
    const Ctor = realm[event.constructor.name] ?? realm.Event
    let copy: Event
    try {
      copy = new Ctor(event.type, event)
    } catch {
      copy = new realm.Event(event.type, event)
    }
    const target = event.target
    Object.defineProperty(copy, 'target', { configurable: true, get: () => target })
    Object.defineProperty(copy, 'composedPath', { configurable: true, value: () => event.composedPath() })
    to.dispatchEvent(copy)
    if (copy.defaultPrevented && event.cancelable) event.preventDefault()
  }

  // A file dropped outside a drop zone would navigate the pop-out away from the call.
  const holdDrop = (event: Event) => event.preventDefault()

  for (const type of FORWARDED_EVENTS) from.addEventListener(type, relay)
  from.addEventListener('dragover', holdDrop)
  from.addEventListener('drop', holdDrop)
  return () => {
    for (const type of FORWARDED_EVENTS) from.removeEventListener(type, relay)
    from.removeEventListener('dragover', holdDrop)
    from.removeEventListener('drop', holdDrop)
  }
}

// ---- realm helpers -----------------------------------------------------------------------

/**
 * ResizeObserver in the realm of the window that shows `el`. A main-realm
 * observer reports a node moved into another document once, as 0x0, and then
 * never again; one from the node's own window keeps reporting.
 */
export function observeResize(el: Element, onResize: () => void): () => void {
  const view = (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis
  const Observer = view.ResizeObserver ?? ResizeObserver
  const observer = new Observer(() => onResize())
  observer.observe(el)
  return () => observer.disconnect()
}

/**
 * LiveKit's adaptive stream sizes each attached <video> through a main-realm
 * ResizeObserver, which goes quiet for nodes in the pop-out (observeResize).
 * HTMLElementInfo.observe() leaves its resize callback on the element as
 * `handleResize`; an observer of the pop-out's realm calls it.
 */
function driveVideoResizes(win: Window, root: Node): () => void {
  const view = win as Window & typeof globalThis
  if (!view.ResizeObserver) return () => {}
  const observer = new view.ResizeObserver((entries) => {
    for (const entry of entries) (entry.target as { handleResize?: () => void }).handleResize?.()
  })
  const watched = new WeakSet<Element>()
  const scan = () => {
    ;(root as ParentNode).querySelectorAll('video').forEach((video) => {
      if (watched.has(video)) return
      watched.add(video)
      observer.observe(video)
    })
  }
  const tree = new MutationObserver(scan)
  tree.observe(root, { childList: true, subtree: true })
  scan()
  return () => {
    tree.disconnect()
    observer.disconnect()
  }
}

// ---- lifecycle ---------------------------------------------------------------------------

const BASE_STYLE_ID = 'call-popout-base'

function ensureContainers(doc: Document, title: string): Pick<CallPopoutState, 'root' | 'activity'> {
  if (!doc.head) doc.documentElement.prepend(doc.createElement('head'))
  if (!doc.body) doc.documentElement.append(doc.createElement('body'))
  if (!doc.getElementById(BASE_STYLE_ID)) {
    const base = doc.createElement('style')
    base.id = BASE_STYLE_ID
    base.textContent = 'html,body{height:100%;margin:0;overflow:hidden;background:var(--background-secondary)}'
    doc.head.append(base)
  }
  doc.title = title
  const container = (id: string) => {
    let el = doc.getElementById(id)
    if (!el) {
      el = doc.createElement('div')
      el.id = id
      doc.body.append(el)
    }
    return el
  }
  return {
    root: container(CALL_POPOUT_IDS.root),
    activity: container(CALL_POPOUT_IDS.activity),
  }
}

interface Session {
  win: Window
  doc: Document
  title: string
  stopDocument: () => void
  stopWindow: () => void
}

let session: Session | null = null
let pending: Promise<boolean> | null = null

function bindDocument(win: Window, title: string): () => void {
  const doc = win.document
  const containers = ensureContainers(doc, title)
  const stops = [
    mirrorDocument(document, doc),
    forwardEvents(win, document),
    driveVideoResizes(win, doc.body),
  ]
  state.root = containers.root
  state.activity = containers.activity
  state.generation++
  return () => stops.forEach((stop) => stop())
}

/**
 * A window.open popup's initial about:blank document can be replaced by the
 * load that follows (desktop webviews); the containers then move to the new
 * document.
 */
function followDocument(): void {
  const s = session
  if (!s || s.win.closed || s.win.document === s.doc) return
  s.stopDocument()
  s.doc = s.win.document
  s.stopDocument = bindDocument(s.win, s.title)
}

function attach(win: Window, kind: CallPopoutKind, title: string): void {
  const onGone = () => {
    if (session?.win === win) detach(false)
  }
  const onLoad = () => followDocument()
  const poll = setInterval(() => {
    if (win.closed) onGone()
    else followDocument()
  }, POLL_MS)
  // A reload or close of the app would orphan a window of dead nodes.
  const onMainHide = () => {
    detach(false)
    if (!win.closed) win.close()
  }
  win.addEventListener('pagehide', onGone)
  win.addEventListener('load', onLoad)
  window.addEventListener('pagehide', onMainHide)

  state.window = win
  state.kind = kind
  session = {
    win,
    doc: win.document,
    title,
    stopDocument: bindDocument(win, title),
    stopWindow: () => {
      clearInterval(poll)
      win.removeEventListener('pagehide', onGone)
      win.removeEventListener('load', onLoad)
      window.removeEventListener('pagehide', onMainHide)
    },
  }
  // Document PiP counts as visible to LiveKit; a plain window does not.
  if (kind === 'window') setPauseVideoInBackground(false)
}

function detach(closeWindow: boolean): void {
  const s = session
  if (!s) return
  session = null
  s.stopWindow()
  s.stopDocument()
  setPauseVideoInBackground(true)
  state.window = null
  state.kind = null
  state.root = null
  state.activity = null
  state.generation++
  if (closeWindow && !s.win.closed) {
    // Teleported nodes move back on the render that follows; the window closes after it.
    void nextTick(() => {
      if (!s.win.closed) s.win.close()
    })
  }
}

export interface OpenCallPopoutOptions {
  title: string
  /** CSS px. */
  width?: number
  height?: number
}

/**
 * Opens the pop-out, or focuses the open one. Resolves false when no window
 * could be opened (blocked popup). Call from the click handler: both window
 * APIs require the click's user activation.
 */
export function openCallPopout(options: OpenCallPopoutOptions): Promise<boolean> {
  if (state.window) {
    focusCallPopout()
    return Promise.resolve(true)
  }
  if (pending) return pending
  const width = Math.round(options.width ?? CALL_POPOUT_DEFAULT_SIZE.width)
  const height = Math.round(options.height ?? CALL_POPOUT_DEFAULT_SIZE.height)

  const openWindow = (): Window | null => {
    try {
      return window.open('about:blank', CALL_POPOUT_NAME, `popup,width=${width},height=${height}`)
    } catch (error) {
      debug.warn('[CallPopout] window.open failed:', error)
      return null
    }
  }

  // The desktop shell gives window.open a titled native window; its webviews'
  // Document PiP support varies by platform.
  const pip = isTauriRuntime() ? null : documentPip(window)
  if (!pip) {
    const win = openWindow()
    if (win) attach(win, 'window', options.title)
    return Promise.resolve(!!win)
  }

  pending = pip
    .requestWindow({ width, height })
    .then((win) => {
      attach(win, 'pip', options.title)
      return true
    })
    .catch((error) => {
      debug.warn('[CallPopout] Document PiP refused, opening a window:', error)
      const win = openWindow()
      if (win) attach(win, 'window', options.title)
      return !!win
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** Returns the call view to the main window and closes the pop-out. */
export function closeCallPopout(): void {
  detach(true)
}

export function focusCallPopout(): void {
  try {
    state.window?.focus()
  } catch {
    // A closing window refuses focus.
  }
}

export function setCallPopoutTitle(title: string): void {
  if (!session) return
  session.title = title
  if (!session.win.closed) session.win.document.title = title
}
