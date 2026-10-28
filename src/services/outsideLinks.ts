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
 * until the dialog opens or cancels it.
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

import { readonly, ref } from 'vue'
import { isTauriRuntime } from '@/services/instanceConfig'
import { useOutsideLinkSettingsStore } from '@/stores/outsideLinkSettings'
import { debug } from '@/utils/debug'
import { isInstanceHost } from '@/utils/internalLinks'
import { MASKED_LINK_CLASS, outsideLinkAction, trustHostOf, type OutsideLinkAction } from '@/utils/outsideLinks'

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
  url: string
  /** trustHostOf(url): what "Trust" stores. */
  host: string | null
  masked: boolean
}

const pending = ref<PendingOutsideLink | null>(null)

function decide(url: string, masked: boolean): OutsideLinkAction {
  const settings = useOutsideLinkSettingsStore()
  return outsideLinkAction(url, {
    masked,
    trustedHosts: settings.trustedHosts,
    askEveryLink: settings.askEveryLink,
    isOwnHost: isInstanceHost,
  })
}

// The dialog returns focus to the element focused when it opens; a link clicked with the
// mouse is not focused in Safari, so it is focused here first.
function ask(url: string, masked: boolean, opener: HTMLElement | null): void {
  if (opener?.isConnected && document.activeElement !== opener) opener.focus({ preventScroll: true })
  pending.value = { url, host: trustHostOf(url), masked }
}

export function useOutsideLinkPrompt() {
  return {
    pending: readonly(pending),
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
  const action = decide(url, masked)
  if (action === 'native' || action === 'refuse') return
  if (action === 'confirm') {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ask(url, masked, options.opener ?? focused)
    return
  }
  launch(url)
}

/** Activation of `anchor` (a click with the primary or middle button). */
export function handleOutsideLinkActivation(event: MouseEvent, anchor: HTMLAnchorElement): void {
  if (event.defaultPrevented || anchor.hasAttribute('download')) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#')) return
  const masked = anchor.classList.contains(MASKED_LINK_CLASS)
  const action = decide(href, masked)
  if (action === 'native') return
  if (action === 'refuse') {
    event.preventDefault()
    return
  }
  if (action === 'confirm') {
    event.preventDefault()
    ask(anchor.href, masked, anchor)
    return
  }
  // A relative href resolves against tauri.localhost: the router's, never the OS browser's.
  if (isTauriRuntime() && (HTTP.test(href) || href.startsWith('//'))) {
    event.preventDefault()
    void openExternalUrl(anchor.href)
  }
}

/** Click listener for an anchor whose click stops before the document (@click.stop). */
export function activateStoppedLink(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLAnchorElement) handleOutsideLinkActivation(event, event.currentTarget)
}

let installed = false

export function installOutsideLinks(): void {
  if (installed) return
  installed = true
  const onActivate = (event: MouseEvent) => {
    if (event.button !== (event.type === 'auxclick' ? 1 : 0)) return
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest<HTMLAnchorElement>('a[href]')
    if (anchor) handleOutsideLinkActivation(event, anchor)
  }
  document.addEventListener('click', onActivate)
  document.addEventListener('auxclick', onActivate)
}
