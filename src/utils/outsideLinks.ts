/**
 * Outside links: what activating a link does, before the "Leaving Harmony" dialog.
 *
 *   own      the document's origin (relative paths included), a blob: URL or this
 *            instance's host (invites, posts, profiles, Drive /d/ links): never asks
 *   native   mailto: and tel:, left to the platform, never asks
 *   refuse   any other scheme: never opened
 *   open     opens at once
 *   confirm  the dialog first
 *
 * An href is read as the browser reads it: resolved against the document's base URL, so
 * "//host", "\\host" and "/\host" name another host.
 *
 * A trusted host never asks. Otherwise a masked link (a url part with a label,
 * utils/maskedLinks, or an anchor whose text names another host) asks, and a plain link asks
 * only with ask-every-link on.
 */

import { anchorLinkLabel, cleanLinkLabel, isDeceptiveLabel } from '@/utils/maskedLinks'

export type OutsideLinkAction = 'own' | 'native' | 'refuse' | 'open' | 'confirm'

export interface OutsideLinkContext {
  masked: boolean
  /** Hosts as trustHostOf gives them. */
  trustedHosts: ReadonlySet<string>
  askEveryLink: boolean
  /** True for a host (URL.host, lower case) of this instance. */
  isOwnHost: (host: string) => boolean
  /** Base URL an href resolves against: the document's. */
  base: string
}

/** Class on an anchor whose text is a label: rendered content only, sanitizers keep class. */
export const MASKED_LINK_CLASS = 'masked-link'

function parseHttp(href: string): URL | null {
  let url: URL
  try {
    url = new URL(href.startsWith('//') ? `https:${href}` : href)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

/**
 * Host a trust decision keys on: URL.host lower case (punycode, default port dropped), without
 * a trailing dot or a leading "www.". Null for anything but an http(s) URL with a host.
 */
export function trustHostOf(href: string): string | null {
  const url = parseHttp(href.trim())
  if (!url || !url.hostname) return null
  const host = url.host.toLowerCase().replace(/\.(?=:\d+$|$)/, '').replace(/^www\./, '')
  return host || null
}

/**
 * Base an href resolves against. A base of another scheme (tauri://localhost on macOS and
 * Linux) is read as https on its host: under a non-special scheme "//host" keeps that scheme
 * and "\\host" is a path, where the OS browser reads both as https://host.
 */
function webBase(base: string): URL | null {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url
  if (!url.host) return null
  try {
    return new URL(`${url.pathname}${url.search}`, `https://${url.host}`)
  } catch {
    return null
  }
}

/** The URL activating `href` opens, resolved against `base`. Null when it does not parse. */
export function resolveLinkHref(href: string, base: string): URL | null {
  const root = webBase(base)
  try {
    return root ? new URL(href.trim(), root) : new URL(href.trim())
  } catch {
    return null
  }
}

export function outsideLinkAction(href: string, ctx: OutsideLinkContext): OutsideLinkAction {
  const url = resolveLinkHref(href, ctx.base)
  if (!url) return 'refuse'
  if (url.protocol === 'blob:') return 'own'
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return 'native'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'refuse'
  if (!url.hostname) return 'refuse'
  if (url.origin === webBase(ctx.base)?.origin || ctx.isOwnHost(url.host.toLowerCase())) return 'own'
  const host = trustHostOf(url.href)
  if (host && ctx.trustedHosts.has(host)) return 'open'
  return ctx.masked || ctx.askEveryLink ? 'confirm' : 'open'
}

/**
 * True when an anchor's visible text names a host other than its http(s) destination's
 * ("https://github.com/me" on a link to evil.example). Text that is the URL in any form, or
 * names no host, is not.
 */
export function isDeceptiveAnchorText(text: string, href: string): boolean {
  if (!/^https?:/i.test(href)) return false
  const label = cleanLinkLabel(text.replace(/\s+/g, ' '))
  return !!label && isDeceptiveLabel(label, href)
}

/**
 * Sanitized `html` with MASKED_LINK_CLASS on each http(s) anchor whose text is not its URL: a
 * label (anchorLinkLabel) or text naming another host. Remote HTML (profile fields) asks
 * before opening such a link, as a url part with a label does.
 */
export function markMaskedAnchors(html: string): string {
  if (!/<a\b/i.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? ''
    const text = anchor.textContent ?? ''
    if (!/^https?:/i.test(href.trim())) continue
    if (anchorLinkLabel(text, href) !== undefined || isDeceptiveAnchorText(text, href)) anchor.classList.add(MASKED_LINK_CLASS)
  }
  return template.innerHTML
}

/**
 * An http(s) URL in three runs for display: everything before the host (scheme, any
 * user:password@), the host with its port, and the rest. Null when it does not parse.
 */
export function splitUrlForDisplay(href: string): { before: string; host: string; after: string } | null {
  const url = parseHttp(href.trim())
  if (!url || !url.hostname) return null
  // WHATWG serialisation: scheme "//" [username [":" password] "@"] host path query fragment.
  const credentials = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  const before = `${url.protocol}//${credentials}`
  return { before, host: url.host, after: url.href.slice(before.length + url.host.length) }
}
