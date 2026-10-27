/**
 * Masked links: `[label](https://…)` in typed text, stored as a url part with a `label`.
 *
 * Part shape: `{ type: 'url', url, preview, label }`. Clients before 1.9.1 ignore `label` and
 * show the bare URL; no capability flag is needed.
 *
 * Grammar, a subset of CommonMark inline links:
 *   [label](https://host/path)     label: one line, no brackets, not blank
 *   [label](<https://host/path>)   angle brackets: linked, no preview (Discord)
 * The destination is http or https only. One level of balanced parentheses is kept in it
 * (`https://en.wikipedia.org/wiki/Foo_(bar)`). A `\` before `[` or a leading `!` (image
 * syntax) leaves the text alone.
 */

const MASKED_LINK_SOURCE =
  '\\[([^\\[\\]\\n]+)\\]\\((?:<(https?:\\/\\/[^\\s<>]+)>|(https?:\\/\\/(?:[^\\s()<>]|\\([^\\s()<>]*\\))+))\\)'

/** Fresh global regex: callers iterate with exec. */
export function maskedLinkRegex(): RegExp {
  return new RegExp(MASKED_LINK_SOURCE, 'gi')
}

export interface MaskedLinkMatch {
  start: number
  end: number
  label: string
  url: string
  /** False for the `<url>` form. */
  preview: boolean
  /** Text between the brackets, untrimmed. */
  rawLabel: string
  /** Text between the parentheses: the URL, in angle brackets for the `<url>` form. */
  rawDestination: string
}

/** Masked links in `text`, in order, outside the ranges `skip` reports. */
export function findMaskedLinks(text: string, skip?: (at: number) => boolean): MaskedLinkMatch[] {
  if (!text || !text.includes('](')) return []
  const out: MaskedLinkMatch[] = []
  const re = maskedLinkRegex()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const before = m.index > 0 ? text[m.index - 1] : ''
    if (before === '\\' || before === '!') continue
    if (skip?.(m.index)) continue
    const label = m[1].trim()
    if (!label) continue
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      label,
      url: m[2] ?? m[3],
      preview: !m[2],
      rawLabel: m[1],
      rawDestination: m[2] ? `<${m[2]}>` : m[3],
    })
  }
  return out
}

/** Source text of a masked link. */
export function maskedLinkSource(label: string, url: string, preview = true): string {
  return `[${label}](${preview ? url : `<${url}>`})`
}

/**
 * Composer text of a url part, for editing: `[label](url)` when it has a label the grammar
 * can hold, else the URL; `<…>` around the URL when it has no preview.
 */
export function urlPartSource(part: { url: string; preview?: unknown; label?: unknown }): string {
  const preview = part.preview !== false && part.preview !== 'false'
  if (typeof part.label === 'string' && isTypableLabel(part.label)) return maskedLinkSource(part.label, part.url, preview)
  return preview ? part.url : `<${part.url}>`
}

/** True when `label` survives a round trip through the grammar unchanged. */
export function isTypableLabel(label: string): boolean {
  return !!label.trim() && label === label.trim() && !/[[\]\n]/.test(label)
}

/**
 * Text replacing a selection that a paste lands on: the selection as the label of the pasted
 * link, whitespace around the selection kept outside it. Null, for a paste that replaces the
 * selection as usual, when the paste is not a single http(s) URL, the selection is no label
 * (blank, several lines, brackets) or is a link itself, or the URL does not survive the grammar.
 */
export function linkPasteText(selected: string, pasted: string): string | null {
  const url = pasted.trim()
  if (!/^https?:\/\/[^\s<>]+$/i.test(url)) return null
  const label = selected.trim()
  if (!isTypableLabel(label) || /^[a-z][a-z0-9+.-]*:\/\//i.test(label)) return null
  const source = maskedLinkSource(label, url)
  const parsed = findMaskedLinks(source)
  if (parsed.length !== 1 || parsed[0].url !== url || parsed[0].end !== source.length) return null
  const lead = selected.slice(0, selected.indexOf(label))
  const trail = selected.slice(lead.length + label.length)
  return lead + source + trail
}

// Bidi overrides and isolates can reverse what a label shows (U+202E turns "moc.lapyap" into
// "paypal.com"); they are dropped from shown labels.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g
// Any format character, zero-width ones included: removed before the deception check so
// "paypal\u200B.com" reads as a domain.
const FORMAT_CHARS = /\p{Cf}/gu
const SCHEME_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+/gi
const WWW_TOKEN = /(?:^|[^\p{L}\p{N}.-])(www\.[^\s/?#]+)/giu
// A whole label that is a host name, optionally with port and path ("paypal.com/login").
const BARE_HOST = /^((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,63}|xn--[a-z0-9-]+))\.?(?::\d+)?(?:[/?#]\S*)?$/iu
// Top-level domains a bare label is checked against: every two-letter country code except
// those that are common file extensions, and the generic ones most hosts sit under. "Node.js",
// "main.rs" and "README.md" are names, not hosts.
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

/**
 * True when the label names a host other than the destination's: a `scheme://host` or
 * `www.host` anywhere in it, or a label that is itself a host name. A host within the
 * destination's own domain (either a subdomain of the other) is not another host. A domain
 * mentioned mid-sentence without www ("log in at paypal.com") is not checked; the shown
 * destination on hover covers it.
 */
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

/**
 * The label a url part shows in place of its URL, or null when it shows the URL: no label,
 * a blank one, or one naming another host.
 */
export function shownLinkLabel(part: UrlPartLike | null | undefined): string | null {
  if (!part || part.type !== 'url' || typeof part.label !== 'string' || typeof part.url !== 'string') return null
  const label = part.label.replace(BIDI_CONTROLS, '').trim()
  if (!label || isDeceptiveLabel(label, part.url)) return null
  return label
}

/**
 * Label of an inbound `<a href>text</a>`: the text, unless it is the URL itself in any form
 * (Mastodon's shortened display included), names a host, spans lines, or is blank.
 */
export function anchorLinkLabel(text: string, href: string): string | undefined {
  const label = text.replace(/\s+/g, ' ').trim()
  if (!label || /[[\]]/.test(label)) return undefined
  const bare = (s: string) => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/[/…]+$/u, '').toLowerCase()
  if (bare(label) === bare(href) || bare(href).startsWith(bare(label))) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(label) || /^www\./i.test(label)) return undefined
  if (isDeceptiveLabel(label, href)) return undefined
  return label
}

/** Host of a URL without a leading www., for "label (host)" plain text. */
export function linkHost(url: string): string {
  return (hostOf(url) ?? '').replace(/^www\./, '')
}

/**
 * Plain text of a url part: the URL, or with a label "label (host)". `withHost: false` gives
 * the label alone.
 */
export function urlPartPlainText(part: UrlPartLike & { url: string }, options: { withHost?: boolean } = {}): string {
  const label = shownLinkLabel(part)
  if (!label) return part.url
  if (options.withHost === false) return label
  const host = linkHost(part.url)
  return host && label.toLowerCase() !== host ? `${label} (${host})` : label
}
