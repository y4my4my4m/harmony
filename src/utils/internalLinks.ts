// Same-instance http(s) links must navigate in-app instead of spawning a new
// PWA window / external browser. Hosts are derived at click time (origin,
// configured app URL, instance domain) — nothing hardcoded.

import type { Router } from 'vue-router'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useRemoteInvitePrompt } from '@/composables/useRemoteInvitePrompt'
import { debug } from '@/utils/debug'

const INVITE_PATH_RE = /^\/invite\/[A-Za-z0-9_-]{4,64}$/

function instanceHosts(): Set<string> {
  const hosts = new Set<string>()
  if (typeof window !== 'undefined' && window.location.host) {
    hosts.add(window.location.host.toLowerCase())
  }
  const appUrl = import.meta.env.VITE_APP_URL as string | undefined
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).host.toLowerCase())
    } catch {
      /* malformed env value */
    }
  }
  try {
    const domain = useInstanceSettingsStore().settings.domain
    if (domain) hosts.add(String(domain).toLowerCase())
  } catch {
    /* pinia not active during early boot */
  }
  return hosts
}

function parseHttpUrl(href: string): URL | null {
  let url: URL
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

export function toInternalPath(href: string): string | null {
  const url = parseHttpUrl(href)
  if (!url || !instanceHosts().has(url.host.toLowerCase())) return null
  return url.pathname + url.search + url.hash
}

// Invite-shaped URL on a foreign host → federated join dialog (compatibility is
// proven by the resolve step there; incompatible hosts just show an error)
export function toRemoteInviteUrl(href: string): string | null {
  const url = parseHttpUrl(href)
  if (!url || instanceHosts().has(url.host.toLowerCase())) return null
  return INVITE_PATH_RE.test(url.pathname) ? url.href : null
}

export function installInternalLinkInterceptor(router: Router): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    // modified clicks keep browser semantics (new tab etc.)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor || anchor.hasAttribute('download')) return
    // opt-out for links that must keep native behavior (e.g. "open in browser" fallbacks)
    if (anchor.closest('[data-no-intercept]')) return

    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('/')) return // router links handle these

    const path = toInternalPath(href)
    if (path) {
      // preventDefault only — stopPropagation would eat the app's other
      // delegated document listeners (haptics) for the same click
      event.preventDefault()
      debug.log('🔗 Internal link intercepted:', href, '→', path)
      void router.push(path)
      return
    }

    const remoteInvite = toRemoteInviteUrl(href)
    if (remoteInvite) {
      event.preventDefault()
      debug.log('🔗 Remote invite intercepted:', remoteInvite)
      useRemoteInvitePrompt().open(remoteInvite)
    }
  }

  document.addEventListener('click', onClick, { capture: true })
  return () => document.removeEventListener('click', onClick, { capture: true })
}
