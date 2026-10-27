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


// Label policy: the label shown in place of a URL, and when the URL shows instead.
//
// The shown label is the label with invisible characters removed: format characters (bidi
// marks, overrides and isolates, zero-width spaces) and default-ignorable code points (U+034F,
// U+115F, U+1160, U+3164, U+FFA0, U+17B4, U+17B5, variation selectors, tags). Kept: a joiner
// between two non-ASCII characters, a variation selector after one, and the tags of a flag
// emoji, as they shape emoji and scripts without width or a bidi class of their own. The host
// check reads that same text.
//
// The check folds it (NFKC, look-alike dots and slashes to `.` and `/`, combining marks and
// default-ignorables removed, lower case) and reads every host-shaped token in it: labels
// joined by dots whose last label has two or more characters, a letter among them; or an IPv4
// address.
//   - A token equal to the destination host (ASCII, a leading www. ignored) is shown as typed.
//   - Any other token naming a host (a known top-level domain, a non-ASCII or punycode one, an
//     IPv4 address, `www.` or `scheme://` before it) makes the label deceptive: the URL shows.
//   - Any other host-shaped token ("Node.js", "README.md", "docs.rs") shows the label as
//     "label (host)", unless a token already names the destination.
// Only http and https destinations show a label.

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const INVISIBLES = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
const JOINER = /^[‌‍]$/u
const VARIATION_SELECTOR = /^[︀-️\u{E0100}-\u{E01EF}]$/u
const TAG = /^[\u{E0020}-\u{E007F}]$/u
const BLACK_FLAG = '\u{1F3F4}'
// After NFKC, which already maps U+2024, U+FE52, U+FF0E to `.`, U+FF61 and U+FE12 to U+3002,
// U+FF65 to U+30FB, U+0387 to U+00B7 and U+FF0F to `/`.
const DOT_LIKE = /[·۔܁܂ᐧ᛫•‧∙⋅⸰⸱⸳。・ꓸ꘎\u{10101}]/gu
const SLASH_LIKE = /[᜵⁄∕╱⟋⧸]/gu
const COMBINING = /\p{M}/gu
const HOST_TOKEN = /[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/
const ASCII = /^[\x00-\x7F]*$/
const SCHEME_BEFORE = /[a-z][a-z0-9+.-]*:\/\/$/
// Two-letter endings read as file extensions, not country codes: a token ending in one is a
// name ("README.md", "main.rs", "Node.js"), shown with the destination host after it.
const FILE_LIKE_ENDINGS = new Set(['md', 'py', 'rs', 'sh', 'ps', 'cs', 'ml', 'so', 'mk', 'cc', 'hs', 'el', 'rb', 'go', 'gz', 'xz', 'js', 'ts', 'kt'])
const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'app', 'dev', 'xyz', 'online', 'site', 'top', 'shop', 'store',
  'club', 'gov', 'edu', 'mil', 'int', 'social', 'cloud', 'lol', 'page', 'blog', 'tech', 'link',
  'live', 'news', 'website', 'space', 'fun', 'icu', 'vip', 'work', 'pro', 'name', 'mobi', 'zip',
  'mov', 'click', 'help', 'support', 'today', 'email', 'login', 'bank', 'pay', 'money', 'finance',
  'game', 'games', 'art', 'wiki', 'chat', 'media', 'network', 'services', 'company', 'one', 'world',
])

function isNamedTld(tld: string): boolean {
  if (!ASCII.test(tld) || tld.startsWith('xn--')) return true
  if (tld.length === 2) return /^[a-z]{2}$/.test(tld) && !FILE_LIKE_ENDINGS.has(tld)
  return GENERIC_TLDS.has(tld)
}

/** The label with invisible characters removed, trimmed: the text a label shows. */
export function cleanLinkLabel(label: string): string {
  const chars = Array.from(label)
  let out = ''
  let prev = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (INVISIBLE.test(ch)) {
      const next = chars[i + 1] ?? ''
      const keep =
        (JOINER.test(ch) && !ASCII.test(prev) && !ASCII.test(next) && !INVISIBLE.test(next)) ||
        (VARIATION_SELECTOR.test(ch) && !ASCII.test(prev)) ||
        (TAG.test(ch) && (prev === BLACK_FLAG || TAG.test(prev)))
      if (!keep) continue
    }
    out += ch
    prev = ch
  }
  return out.trim()
}

/** Host of an http(s) URL, lower case, without a trailing dot; null for any other URL. */
function destinationHost(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.hostname.toLowerCase().replace(/\.$/, '') || null
}

function foldForCheck(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DOT_LIKE, '.')
    .replace(SLASH_LIKE, '/')
    .replace(INVISIBLES, '')
    .replace(COMBINING, '')
    .toLowerCase()
}

type LabelVerdict = 'shown' | 'qualified' | 'deceptive'

interface LabelCheck {
  verdict: LabelVerdict
  /** A token of the label is the destination host. */
  namesDestination: boolean
}

function checkLabel(shown: string, host: string): LabelCheck {
  const site = host.replace(/^www\./, '')
  const text = foldForCheck(shown)
  let namesDestination = false
  let otherName = false
  for (const m of text.matchAll(HOST_TOKEN)) {
    const token = m[0]
    const tld = token.slice(token.lastIndexOf('.') + 1)
    const ipv4 = IPV4.test(token)
    if (!ipv4 && (tld.length < 2 || !/\p{L}/u.test(tld))) continue
    if (ASCII.test(token) && token.replace(/^www\./, '') === site) {
      namesDestination = true
      continue
    }
    const named = ipv4 || isNamedTld(tld) || token.startsWith('www.') || SCHEME_BEFORE.test(text.slice(0, m.index))
    if (named) return { verdict: 'deceptive', namesDestination }
    otherName = true
  }
  return { verdict: otherName && !namesDestination ? 'qualified' : 'shown', namesDestination }
}

/**
 * True when the label names a host other than the destination's, or the destination is not
 * http(s). A host-shaped name that is no known host ("Node.js") is not deceptive; it shows
 * with the destination host after it.
 */
export function isDeceptiveLabel(label: string, url: string): boolean {
  const host = destinationHost(url)
  if (!host) return true
  return checkLabel(cleanLinkLabel(label), host).verdict === 'deceptive'
}

type UrlPartLike = { type?: unknown; url?: unknown; label?: unknown }

function shownLabelOf(part: UrlPartLike | null | undefined): { text: string; namesDestination: boolean } | null {
  if (!part || part.type !== 'url' || typeof part.label !== 'string' || typeof part.url !== 'string') return null
  const host = destinationHost(part.url)
  const label = cleanLinkLabel(part.label)
  if (!host || !label) return null
  const check = checkLabel(label, host)
  if (check.verdict === 'deceptive') return null
  if (check.verdict === 'qualified') return { text: `${label} (${host.replace(/^www\./, '')})`, namesDestination: true }
  return { text: label, namesDestination: check.namesDestination }
}

/**
 * The text a url part shows in place of its URL, or null when it shows the URL: no label, a
 * blank one, one naming another host, or a destination that is not http(s). A label holding
 * a host-shaped name that is no known host ends in the destination host: "Node.js (nodejs.org)".
 */
export function shownLinkLabel(part: UrlPartLike | null | undefined): string | null {
  return shownLabelOf(part)?.text ?? null
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

/** Host of an http(s) URL without a leading www., for "label (host)" plain text. */
export function linkHost(url: string): string {
  return (destinationHost(url) ?? '').replace(/^www\./, '')
}

/**
 * Plain text of a url part: the URL, or with a label "label (host)", the host left out when
 * the shown label names it. `withHost: false` gives the shown label alone.
 */
export function urlPartPlainText(part: UrlPartLike & { url: string }, options: { withHost?: boolean } = {}): string {
  const shown = shownLabelOf(part)
  if (!shown) return part.url
  if (options.withHost === false || shown.namesDestination) return shown.text
  const host = linkHost(part.url)
  return host ? `${shown.text} (${host})` : shown.text
}
