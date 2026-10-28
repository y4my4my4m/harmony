/**
 * Outside links: what activating a link does, before the "Leaving Harmony" dialog.
 *
 *   own      a relative path, a blob: URL or this instance's origin (invites, posts,
 *            profiles, Drive /d/ links): never asks
 *   native   mailto: and tel:, left to the platform, never asks
 *   refuse   any other scheme: never opened
 *   open     opens at once
 *   confirm  the dialog first
 *
 * A trusted host never asks. Otherwise a masked link (a url part with a label,
 * utils/maskedLinks) asks, and a plain link asks only with ask-every-link on.
 */

export type OutsideLinkAction = 'own' | 'native' | 'refuse' | 'open' | 'confirm'

export interface OutsideLinkContext {
  masked: boolean
  /** Hosts as trustHostOf gives them. */
  trustedHosts: ReadonlySet<string>
  askEveryLink: boolean
  /** True for a host (URL.host, lower case) of this instance. */
  isOwnHost: (host: string) => boolean
}

/** Class on an anchor whose text is a label: rendered content only, sanitizers keep class. */
export const MASKED_LINK_CLASS = 'masked-link'

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

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

export function outsideLinkAction(href: string, ctx: OutsideLinkContext): OutsideLinkAction {
  const raw = href.trim()
  if (!raw.startsWith('//')) {
    const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase()
    if (!scheme) return 'own'
    if (scheme === 'blob') return 'own'
    if (scheme === 'mailto' || scheme === 'tel') return 'native'
    if (scheme !== 'http' && scheme !== 'https') return 'refuse'
  }
  const url = parseHttp(raw)
  if (!url || !url.hostname) return 'refuse'
  if (ctx.isOwnHost(url.host.toLowerCase())) return 'own'
  const host = trustHostOf(raw)
  if (host && ctx.trustedHosts.has(host)) return 'open'
  return ctx.masked || ctx.askEveryLink ? 'confirm' : 'open'
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
