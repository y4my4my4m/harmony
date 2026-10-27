/**
 * Links to posts on X, Instagram and Bluesky in content the user sends, rewritten to an
 * embed-fixer mirror (fixupx.com, kkinstagram.com, fxbsky.app...) whose page other apps
 * (Discord, Telegram, Mastodon) turn into a preview with the post's media. Harmony itself
 * previews mirror links as the post (federation-backend services/socialEmbeds.ts).
 *
 * Applied by the content parser (unifiedContentProcessing.parseTextForUrls) to every url part
 * it makes, so code spans and fenced blocks keep their text. The preference is the visual
 * theme's `linkMirrors`, mirrored here by useVisualTheme so the parser reads no store.
 *
 * X is on by default: fixupx.com is FxTwitter's. Instagram and Bluesky mirrors come and go
 * (2026-10-22: ddinstagram.com no longer resolves, instagramez.com redirects to an ad
 * network), and a stored link to a dead mirror stays dead, so they are off by default.
 */

export type MirrorSite = 'x' | 'instagram' | 'bluesky'

export interface MirrorSitePreference {
  enabled?: boolean
  host?: string
}

export type MirrorLinkPreferences = Partial<Record<MirrorSite, MirrorSitePreference>>

export const MIRROR_SITES: readonly MirrorSite[] = ['x', 'instagram', 'bluesky']

/** Mirrors a user can pick, per site; the first is the default. */
export const MIRROR_HOSTS: Record<MirrorSite, readonly string[]> = {
  x: ['fixupx.com', 'vxtwitter.com', 'fxtwitter.com'],
  instagram: ['kkinstagram.com', 'eeinstagram.com'],
  bluesky: ['fxbsky.app', 'bskye.app'],
}

const ENABLED_BY_DEFAULT: Record<MirrorSite, boolean> = { x: true, instagram: false, bluesky: false }

export const MIRROR_SITE_NAMES: Record<MirrorSite, string> = { x: 'X', instagram: 'Instagram', bluesky: 'Bluesky' }

/** Every site's preference with defaults filled in; a host off the list is the default host. */
export function resolveMirrorPreferences(prefs?: MirrorLinkPreferences | null): Record<MirrorSite, Required<MirrorSitePreference>> {
  const out = {} as Record<MirrorSite, Required<MirrorSitePreference>>
  for (const site of MIRROR_SITES) {
    const own = prefs?.[site]
    out[site] = {
      enabled: typeof own?.enabled === 'boolean' ? own.enabled : ENABLED_BY_DEFAULT[site],
      host: own?.host && MIRROR_HOSTS[site].includes(own.host) ? own.host : MIRROR_HOSTS[site][0],
    }
  }
  return out
}

/**
 * Every host serving a site's post links: the site and its embed-fixer mirrors, selectable or
 * not. Mirrors X_HOSTS, INSTAGRAM_HOSTS and BLUESKY_HOSTS in
 * federation-backend/src/services/socialEmbeds.ts.
 */
export const SOCIAL_SITE_HOSTS: Record<MirrorSite, readonly string[]> = {
  x: [
    'x.com', 'twitter.com',
    'vxtwitter.com', 'fxtwitter.com', 'fixupx.com', 'fixvx.com',
    'twittpr.com', 'girlcockx.com', 'nitter.net', 'xcancel.com',
  ],
  instagram: [
    'instagram.com', 'instagr.am',
    'kkinstagram.com', 'ddinstagram.com', 'uuinstagram.com', 'eeinstagram.com',
    'vxinstagram.com', 'instagramez.com', 'fxstagram.com',
  ],
  bluesky: ['bsky.app', 'fxbsky.app', 'bskye.app', 'bskx.app', 'vxbsky.app'],
}

/** The site whose post links `hostname` serves, mirrors included; the subdomain prefixes are socialEmbeds' hostOf. */
export function socialSiteOfHost(hostname: string): MirrorSite | null {
  const host = hostname.toLowerCase().replace(/^(www|mobile|m|d|g)\./, '')
  for (const site of MIRROR_SITES) {
    if (SOCIAL_SITE_HOSTS[site].includes(host)) return site
  }
  return null
}

const X_SOURCE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/
const INSTAGRAM_SOURCE = /^(?:www\.|m\.)?instagram\.com$/
const BLUESKY_SOURCE = /^(?:www\.)?bsky\.app$/

/**
 * `url` on the mirror the preferences pick for its site, when it is a post link of that site:
 *   x.com or twitter.com /<user>/status/<id>
 *   instagram.com [/<user>]/(p|reel|reels|tv)/<code>, rewritten to /p|reel|tv/<code>/
 *   bsky.app /profile/<handle or did>/post/<rkey>
 * Anything else, a mirror link included, comes back unchanged.
 */
export function mirrorLink(url: string, prefs: Record<MirrorSite, Required<MirrorSitePreference>>): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url
  if (parsed.username || parsed.password || parsed.port) return url
  const host = parsed.hostname.toLowerCase()

  const to = (site: MirrorSite, pathname = parsed.pathname): string => {
    if (!prefs[site].enabled) return url
    return `https://${prefs[site].host}${pathname}${parsed.search}${parsed.hash}`
  }

  if (X_SOURCE.test(host)) {
    return /^\/(?:[A-Za-z0-9_]{1,15}|i)\/status(?:es)?\/\d{1,20}(?:\/|$)/.test(parsed.pathname) ? to('x') : url
  }
  if (INSTAGRAM_SOURCE.test(host)) {
    const m = parsed.pathname.match(/^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,40})\/?$/)
    if (!m) return url
    const kind = m[1] === 'reels' ? 'reel' : m[1]
    return to('instagram', `/${kind}/${m[2]}/`)
  }
  if (BLUESKY_SOURCE.test(host)) {
    return /^\/profile\/[^/]+\/post\/[a-z0-9]{2,32}\/?$/i.test(parsed.pathname) ? to('bluesky') : url
  }
  return url
}

let current = resolveMirrorPreferences(undefined)

/** Sets the preferences the parser applies. */
export function setMirrorLinkPreferences(prefs: MirrorLinkPreferences | null | undefined): void {
  current = resolveMirrorPreferences(prefs)
}

/** The preferences the parser applies now. */
export function mirrorLinkPreferences(): Record<MirrorSite, Required<MirrorSitePreference>> {
  return current
}
