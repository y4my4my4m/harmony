/**
 * The one path every outside link opens through, on the web and in the native clients.
 *
 * - installOutsideLinks: a delegated document listener for anchor activation (click, middle
 *   click, Enter on a focused link). Bubble phase: a component that handles its own anchor
 *   calls preventDefault and wins. Same-instance links are routed in-app earlier, in the
 *   capture phase (utils/internalLinks).
 * - openLink: links opened from code.
 * - activateStoppedLink: anchors whose click stops before the document.
 *
 * Each asks utils/outsideLinks what to do. "confirm" holds the link in useOutsideLinkPrompt
 * until the dialog opens or cancels it. The held link names the document of its opener: the
 * dialog shows in that window, the call pop-out's included (App.vue hosts one per window).
 *
 * Web: a link that needs no confirmation keeps the browser's behaviour, modifiers and middle
 * click included. A link that needs one is stopped whatever opens it (click, Ctrl/Cmd/Shift
 * click, middle click): its label can hide the destination however it is opened. Open in
 * the dialog opens it in a new tab. The browser's context menu ("Open link in new tab") is
 * out of reach; it opens the href the status bar shows.
 *
 * Native clients: <a target="_blank"> and window.open do nothing in the Tauri webview (or load
 * the page inside it on Android), so every http(s) link not handled elsewhere opens here.
 */

import { computed, shallowRef } from 'vue'
import { isTauriRuntime } from '@/services/instanceConfig'
import { useOutsideLinkSettingsStore } from '@/stores/outsideLinkSettings'
import { debug } from '@/utils/debug'
import { isInstanceHost } from '@/utils/internalLinks'
import {
  MASKED_LINK_CLASS,
  isDeceptiveAnchorText,
  outsideLinkAction,
  resolveLinkHref,
  trustHostOf,
  type OutsideLinkAction,
} from '@/utils/outsideLinks'

const HTTP = /^https?:\/\//i

/** Native clients only. Android: an ACTION_VIEW intent. Desktop and iOS: tauri-plugin-opener. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!HTTP.test(url)) return
  try {
    if (/Android/i.test(navigator.userAgent)) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('android_open_url', { url })
    } else {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    }
  } catch (err) {
    debug.warn('[outsideLinks] failed to open external URL:', err)
  }
}

/** Opens an http(s) URL outside the app without asking. Synchronous on the web: window.open keeps the click's activation. */
function launch(url: string): void {
  if (!HTTP.test(url)) return
  if (isTauriRuntime()) {
    void openExternalUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export interface PendingOutsideLink {
  /** The resolved URL: what Open opens. */
  url: string
  /** trustHostOf(url): what "Trust" stores. */
  host: string | null
  masked: boolean
  /** Document of the window the dialog shows in: its opener's. */
  document: Document
}

// Shallow: `document` is compared by identity.
const pending = shallowRef<PendingOutsideLink | null>(null)

/**
 * Base an href of `doc` resolves against. The native webview's scheme (tauri://localhost,
 * http://tauri.localhost) is no web scheme: a scheme-relative link opens over https.
 */
function linkBase(doc: Document): string {
  const base = doc.baseURI
  return isTauriRuntime() ? base.replace(/^[a-z][a-z0-9+.-]*:/i, 'https:') : base
}

interface Decision {
  action: OutsideLinkAction
  /** The resolved URL; empty when it does not parse. */
  url: string
}

function decide(href: string, masked: boolean, base: string): Decision {
  const settings = useOutsideLinkSettingsStore()
  const action = outsideLinkAction(href, {
    masked,
    trustedHosts: settings.trustedHosts,
    askEveryLink: settings.askEveryLink,
    isOwnHost: isInstanceHost,
    base,
  })
  return { action, url: resolveLinkHref(href, base)?.href ?? '' }
}

// The dialog returns focus to the element focused when it opens; a link clicked with the
// mouse is not focused in Safari, so it is focused here first.
function ask(url: string, masked: boolean, opener: HTMLElement | null): void {
  const doc = opener?.ownerDocument ?? document
  if (opener?.isConnected && doc.activeElement !== opener) opener.focus({ preventScroll: true })
  pending.value = { url, host: trustHostOf(url), masked, document: doc }
}

export function useOutsideLinkPrompt() {
  return {
    pending: computed(() => pending.value),
    /** Opens the held link; with `trust`, its host opens without asking from now on. */
    proceed(trust: boolean): Promise<void> {
      const link = pending.value
      pending.value = null
      if (!link) return Promise.resolve()
      launch(link.url)
      return trust && link.host ? useOutsideLinkSettingsStore().trust(link.host) : Promise.resolve()
    },
    cancel(): void {
      pending.value = null
    },
  }
}

export interface OpenLinkOptions {
  /** The URL is a masked link's, or a preview of one. */
  masked?: boolean
  /** Focus returns here when the dialog closes; default the focused element. */
  opener?: HTMLElement | null
}

/** Opens an http(s) URL from code: asks first when the link needs it. Other schemes never open. */
export function openLink(url: string, options: OpenLinkOptions = {}): void {
  const masked = !!options.masked
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const opener = options.opener ?? focused
  const decision = decide(url, masked, linkBase(opener?.ownerDocument ?? document))
  if (decision.action === 'native' || decision.action === 'refuse') return
  if (decision.action === 'confirm') {
    ask(decision.url, masked, opener)
    return
  }
  launch(decision.url)
}

/**
 * Activation of `anchor` (a click with the primary or middle button). Masked: the masked-link
 * class, or text naming another host than the href's.
 */
export function handleOutsideLinkActivation(event: MouseEvent, anchor: HTMLAnchorElement): void {
  if (event.defaultPrevented || anchor.hasAttribute('download')) return
  const href = anchor.getAttribute('href')
  if (!href || href.trim().startsWith('#')) return
  const base = linkBase(anchor.ownerDocument)
  const resolved = resolveLinkHref(href, base)?.href ?? ''
  const masked = anchor.classList.contains(MASKED_LINK_CLASS) || isDeceptiveAnchorText(anchor.textContent ?? '', resolved)
  const decision = decide(href, masked, base)
  if (decision.action === 'native') return
  if (decision.action === 'refuse') {
    event.preventDefault()
    return
  }
  if (decision.action === 'confirm') {
    event.preventDefault()
    ask(decision.url, masked, anchor)
    return
  }
  // Native app: an outside link, or a link to this instance on another origin than the
  // webview's that the router left (modified or middle click), opens in the OS browser.
  if (isTauriRuntime() && HTTP.test(decision.url) && originOf(decision.url) !== originOf(base)) {
    event.preventDefault()
    void openExternalUrl(decision.url)
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// Nodes in the call pop-out can belong to its realm, where instanceof against this realm fails.
function isAnchor(node: EventTarget | null): node is HTMLAnchorElement {
  return !!node && (node as Element).localName === 'a' && typeof (node as Element).getAttribute === 'function'
}

/** Click listener for an anchor whose click stops before the document (@click.stop). */
export function activateStoppedLink(event: MouseEvent): void {
  if (isAnchor(event.currentTarget)) handleOutsideLinkActivation(event, event.currentTarget)
}

// One middle press can arrive as both a click with button 1 and an auxclick: the second
// follows the first's decision. Ms between them.
const MIDDLE_PRESS_MS = 100

let installed = false

export function installOutsideLinks(): void {
  if (installed) return
  installed = true
  let lastMiddle: { anchor: Element; at: number; prevented: boolean } | null = null
  const onActivate = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    if (event.type === 'auxclick' && event.button !== 1) return
    const target = event.target as Element | null
    const anchor = typeof target?.closest === 'function' ? target.closest('a[href]') : null
    if (!isAnchor(anchor)) return
    if (event.button !== 1) {
      handleOutsideLinkActivation(event, anchor)
      return
    }
    const first = lastMiddle
    if (first && first.anchor === anchor && event.timeStamp - first.at < MIDDLE_PRESS_MS) {
      if (first.prevented) event.preventDefault()
      return
    }
    handleOutsideLinkActivation(event, anchor)
    lastMiddle = { anchor, at: event.timeStamp, prevented: event.defaultPrevented }
  }
  document.addEventListener('click', onActivate)
  document.addEventListener('auxclick', onActivate)
}
