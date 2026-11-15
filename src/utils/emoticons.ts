/**
 * Text emoticon to emoji conversion: Discord's set, and five Harmony additions.
 *
 * An emoticon converts only as a standalone token: preceded by start of text,
 * whitespace or an opening bracket/quote/markdown marker, and followed by end
 * of text, whitespace, closing punctuation or a markdown marker. Never
 * converted: fenced and inline code, `:shortcode:` tokens, and any
 * whitespace-delimited word containing `://`, `@` or a leading `www.` (URLs,
 * emails, mentions, handles) other than a word that is itself an emoticon (`:@`).
 * `>:(` and its variants convert mid-line only: at the start of a line `>` opens greentext.
 */

/**
 * Discord's emoticon table, one row per emoji in Discord's order. Case is Discord's:
 * `:P` converts and `:s` does, `:S` does not.
 */
const DISCORD_EMOTICONS: ReadonlyArray<readonly [emoji: string, emoticons: string]> = [
  ['😠', '>:( >:-( >=( >=-('],
  ['😊', ':") :-") =") =-")'],
  ['💔', '</3 <\\3'],
  ['😕', ':-\\ :-/ =-\\ =-/'],
  ['😢', ":'( :'-( :,( :,-( ='( ='-( =,( =,-("],
  ['😦', ':( :-( =( =-('],
  ['❤️', '<3 ♡'],
  ['👿', ']:( ]:-( ]=( ]=-('],
  ['😇', 'o:) O:) o:-) O:-) 0:) 0:-) o=) O=) o=-) O=-) 0=) 0=-)'],
  ['😂', ":'D :'-D :,D :,-D ='D ='-D =,D =,-D"],
  ['😗', ':* :-* =* =-*'],
  ['😆', 'x-) X-)'],
  ['😐', ':| :-| =| =-|'],
  ['😮', ':o :-o :O :-O =o =-o =O =-O'],
  ['😡', ':@ :-@ =@ =-@'],
  ['😄', ':D :-D =D =-D'],
  ['🥲', ":') :'-) :,) :,-) =') ='-) =,) =,-)"],
  ['🙂', ':) :-) =) =-)'],
  ['😈', ']:) ]:-) ]=) ]=-)'],
  ['😭', ":,'( :,'-( ;( ;-( =,'( =,'-("],
  ['😛', ':P :-P =P =-P'],
  ['😎', '8-) B-)'],
  ['😓', ',:( ,:-( ,=( ,=-('],
  ['😅', ',:) ,:-) ,=) ,=-)'],
  ['😒', ':s :-S :z :-Z :$ :-$ =s =-S =z =-Z =$ =-$'],
  ['😉', ';) ;-)'],
]

/** Not in Discord's table. */
const HARMONY_EMOTICONS: ReadonlyArray<readonly [string, string]> = [
  ['😛', ':p :-p'],
  ['😆', 'xD XD'],
  ['😕', ':/'],
]

export const EMOTICONS: ReadonlyArray<readonly [string, string]> = [...DISCORD_EMOTICONS, ...HARMONY_EMOTICONS]
  .flatMap(([emoji, emoticons]) => emoticons.split(' ').map((emoticon) => [emoticon, emoji] as const))

const EMOTICON_MAP = new Map(EMOTICONS)

/** The emoji `text` converts to when `text` is exactly an emoticon. */
export function emoticonEmoji(text: string): string | undefined {
  return EMOTICON_MAP.get(text)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Longest first: `:-)` before `:)`, `</3` before `<3`. An emoticon led by `>` does not match
// at the start of a line.
const EMOTICON_REGEX = new RegExp(
  `(?<=^|[\\s(\\[{"'*_~|])(${[...EMOTICON_MAP.keys()]
    .sort((a, b) => b.length - a.length)
    .map((e) => (e.startsWith('>') ? '(?<!^)(?<!\\n)' : '') + escapeRe(e))
    .join('|')})(?=$|[\\s.,!?;)\\]}"'*_~|])`,
  'g',
)

// Opaque spans: fenced code, inline code, :shortcode:, and words holding
// `://`, `@` or starting with `www.`.
const OPAQUE_REGEX = /```[\s\S]*?(?:```|$)|`[^`\n]+`|:[a-zA-Z0-9_+~-]+:|(?<!\S)\S*(?::\/\/|@)\S*|(?<!\S)www\.\S+/g

// An opaque word that is `:@` or a variant, between the delimiters EMOTICON_REGEX accepts.
const AT_EMOTICON_REGEX = /^([([{"'*_~|]*)([:=]-?@)([.,!?;)\]}"'*_~|]*)$/

/** False when `text` holds no character that every emoticon has one of. */
function mayContainEmoticon(text: string): boolean {
  return /[:;<=♡]|-\)|xD|XD/.test(text)
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
    const at = AT_EMOTICON_REGEX.exec(m[0])
    out += at ? at[1] + EMOTICON_MAP.get(at[2]) + at[3] : m[0]
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
