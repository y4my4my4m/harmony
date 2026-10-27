/**
 * Masked links: url parts with a `label` (`[label](url)` typed in the composer).
 * Mirrors isDeceptiveLabel, shownLinkLabel, anchorLinkLabel and urlPartPlainText of
 * src/utils/maskedLinks.ts.
 *
 * Outbound Note HTML for a labelled url part:
 *   <a href="URL" rel="nofollow noopener noreferrer" target="_blank">LABEL</a><span class="invisible"> (URL)</span>
 * Mastodon keeps the `invisible` class on remote content and hides the span. A receiver that
 * drops anchors and keeps their text (Harmony 1.9.0 and older) reads "LABEL (URL)" and links
 * the URL. noteToContent of this version folds anchor and span back into one labelled part.
 */

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g
const FORMAT_CHARS = /\p{Cf}/gu
const SCHEME_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+/gi
const WWW_TOKEN = /(?:^|[^\p{L}\p{N}.-])(www\.[^\s/?#]+)/giu
const BARE_HOST = /^((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,63}|xn--[a-z0-9-]+))\.?(?::\d+)?(?:[/?#]\S*)?$/iu
const FILE_LIKE_COUNTRY_CODES = new Set(['md', 'py', 'rs', 'sh', 'pl', 'ps', 'cs', 'ml', 'so', 'mk', 'cc', 'hs', 'el', 'rb', 'go', 'gz', 'xz', 'js', 'ts', 'kt'])
const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'app', 'dev', 'xyz', 'online', 'site', 'top', 'shop', 'store',
  'club', 'gov', 'edu', 'mil', 'int', 'social', 'cloud', 'lol', 'page', 'blog', 'tech', 'link',
  'live', 'news', 'website', 'space', 'fun', 'icu', 'vip', 'work', 'pro', 'name', 'mobi', 'zip',
  'mov', 'click', 'help', 'support', 'today', 'email', 'login', 'bank', 'pay', 'money', 'finance',
  'game', 'games', 'art', 'wiki', 'chat', 'media', 'network', 'services', 'company', 'one', 'world',
])

function isHostTld(tld: string): boolean {
  const t = tld.toLowerCase()
  if (t.startsWith('xn--')) return true
  if (t.length === 2) return /^[a-z]{2}$/.test(t) && !FILE_LIKE_COUNTRY_CODES.has(t)
  return GENERIC_TLDS.has(t)
}

function hostOf(text: string): string | null {
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname
    return host ? host.toLowerCase().replace(/\.$/, '') : null
  } catch {
    return null
  }
}

function sameSite(a: string, b: string): boolean {
  const x = a.replace(/^www\./, '')
  const y = b.replace(/^www\./, '')
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/** True when the label names a host other than the destination's. */
export function isDeceptiveLabel(label: string, url: string): boolean {
  const target = hostOf(url)
  if (!target) return true
  const text = label.replace(FORMAT_CHARS, '').trim()
  const hosts: string[] = []
  for (const m of text.matchAll(SCHEME_TOKEN)) hosts.push(m[0])
  for (const m of text.matchAll(WWW_TOKEN)) hosts.push(m[1])
  const bare = BARE_HOST.exec(text)
  if (bare && isHostTld(bare[2])) hosts.push(bare[1])
  return hosts.some((h) => {
    const host = hostOf(h)
    return !host || !sameSite(host, target)
  })
}

type UrlPartLike = { type?: unknown; url?: unknown; label?: unknown }

/** The label a url part shows in place of its URL, or null when it shows the URL. */
export function shownLinkLabel(part: UrlPartLike | null | undefined): string | null {
  if (!part || part.type !== 'url' || typeof part.label !== 'string' || typeof part.url !== 'string') return null
  const label = part.label.replace(BIDI_CONTROLS, '').trim()
  if (!label || isDeceptiveLabel(label, part.url)) return null
  return label
}

/** Label of an inbound `<a href>text</a>`, or undefined when the text is the URL, a host, or blank. */
export function anchorLinkLabel(text: string, href: string): string | undefined {
  const label = text.replace(/\s+/g, ' ').trim()
  if (!label || /[[\]]/.test(label)) return undefined
  const bare = (s: string) => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/[/…]+$/u, '').toLowerCase()
  if (bare(label) === bare(href) || bare(href).startsWith(bare(label))) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(label) || /^www\./i.test(label)) return undefined
  if (isDeceptiveLabel(label, href)) return undefined
  return label
}

export function linkHost(url: string): string {
  return (hostOf(url) ?? '').replace(/^www\./, '')
}

/** Plain text of a url part: the URL, or "label (host)". */
export function urlPartPlainText(part: UrlPartLike & { url: string }): string {
  const label = shownLinkLabel(part)
  if (!label) return part.url
  const host = linkHost(part.url)
  return host && label.toLowerCase() !== host ? `${label} (${host})` : label
}
