/**
 * Text emoticon to emoji conversion, Discord's set plus nose variants.
 *
 * An emoticon converts only as a standalone token: preceded by start of text,
 * whitespace or an opening bracket/quote/markdown marker, and followed by end
 * of text, whitespace, closing punctuation or a markdown marker. Never
 * converted: fenced and inline code, `:shortcode:` tokens, and any
 * whitespace-delimited word containing `://`, `@` or a leading `www.` (URLs,
 * emails, mentions, handles).
 */

export const EMOTICONS: ReadonlyArray<readonly [string, string]> = [
  [":'(", '😢'],
  [':-)', '🙂'],
  [':-(', '🙁'],
  [':-D', '😃'],
  [';-)', '😉'],
  [':-P', '😛'],
  [':-p', '😛'],
  [':-O', '😮'],
  [':-o', '😮'],
  [':-|', '😐'],
  [':-/', '😕'],
  ['</3', '💔'],
  [':D', '😃'],
  [':)', '🙂'],
  [':(', '🙁'],
  [';)', '😉'],
  [':P', '😛'],
  [':p', '😛'],
  ['<3', '❤️'],
  [':O', '😮'],
  [':o', '😮'],
  ['xD', '😆'],
  ['XD', '😆'],
  [':|', '😐'],
  [':/', '😕'],
]

const EMOTICON_MAP = new Map(EMOTICONS)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Longest first: `:-)` before `:)`, `</3` before `<3`.
const EMOTICON_REGEX = new RegExp(
  `(?<=^|[\\s(\\[{"'*_~|])(${[...EMOTICON_MAP.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')})(?=$|[\\s.,!?;)\\]}"'*_~|])`,
  'g',
)

// Opaque spans: fenced code, inline code, :shortcode:, and words holding
// `://`, `@` or starting with `www.`.
const OPAQUE_REGEX = /```[\s\S]*?(?:```|$)|`[^`\n]+`|:[a-zA-Z0-9_+~-]+:|(?<!\S)\S*(?::\/\/|@)\S*|(?<!\S)www\.\S+/g

/** False when `text` lacks every character the emoticons share (`:`, `;`, `<`, `D`). */
function mayContainEmoticon(text: string): boolean {
  return text.includes(':') || text.includes(';') || text.includes('<') || text.includes('D')
}

function convertPlain(text: string): string {
  if (!mayContainEmoticon(text)) return text
  EMOTICON_REGEX.lastIndex = 0
  // A repeated final character (`:))`, `:((`) is an emphasised emoticon left as typed.
  return text.replace(EMOTICON_REGEX, (m: string, _g: string, offset: number) =>
    text[offset + m.length] === m[m.length - 1] ? m : (EMOTICON_MAP.get(m) ?? m),
  )
}

/** Replaces standalone emoticons in `text` with emoji; see the module header. */
export function convertEmoticons(text: string): string {
  if (!text || !mayContainEmoticon(text)) return text
  let out = ''
  let last = 0
  OPAQUE_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPAQUE_REGEX.exec(text)) !== null) {
    if (m[0].length === 0) {
      OPAQUE_REGEX.lastIndex++
      continue
    }
    // Each segment converts on its own; lookbehind and lookahead see the
    // segment edge as start/end, so the opaque neighbour must be whitespace-separated.
    if (m.index > last) out += convertSegment(text, last, m.index)
    out += m[0]
    last = m.index + m[0].length
  }
  if (last < text.length) out += convertSegment(text, last, text.length)
  return out
}

/**
 * Converts text[start, end). A segment edge counts as a delimiter only when the
 * neighbouring character in the full text is whitespace or absent.
 */
function convertSegment(text: string, start: number, end: number): string {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  const leftOpen = before === '' || /\s/.test(before)
  const rightOpen = after === '' || /\s/.test(after)
  // Sentinels block a match at an edge glued to an opaque span.
  const head = leftOpen ? '' : '\u0000'
  const tail = rightOpen ? '' : '\u0000'
  const converted = convertPlain(head + text.slice(start, end) + tail)
  return converted.slice(head.length, converted.length - tail.length)
}
