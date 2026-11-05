/**
 * Unicode emoji sequences in text, after UTS #51: a flag (two regional indicators), a keycap,
 * a pictograph with its skin tone, VS16 or tag sequence, and ZWJ sequences of these, each one
 * match. A pictograph of text presentation by default (©, ™, ☺) is an emoji only with VS16 or
 * a skin tone; VS15 (U+FE0E) after any pictograph keeps it text.
 */

const VS16 = '\\uFE0F'
const MODIFIER = '\\p{Emoji_Modifier}'
const TAG_SEQUENCE = '[\\u{E0020}-\\u{E007E}]+\\u{E007F}'
const SUFFIX = `(?:${VS16}|${MODIFIER}|${TAG_SEQUENCE})?`
// First element of a sequence: drawn as emoji on its own.
const LEAD = `(?:\\p{Emoji_Modifier_Base}${MODIFIER}|\\p{Emoji_Presentation}(?!\\uFE0E)|\\p{Extended_Pictographic}${VS16})${SUFFIX}`
// Element after a ZWJ: any pictograph; minimally-qualified sequences omit its VS16.
const JOINED = `(?:\\p{Emoji_Modifier_Base}${MODIFIER}|\\p{Extended_Pictographic}|\\p{Emoji_Presentation})${SUFFIX}`
const SEQUENCE = `\\p{Regional_Indicator}{2}|[#*0-9]${VS16}?\\u20E3|${LEAD}(?:\\u200D${JOINED})*`

/** A fresh global regex of emoji sequences; `g` regexes keep lastIndex, so none is shared. */
export function emojiSequenceRegex(): RegExp {
  return new RegExp(SEQUENCE, 'gu')
}

const SINGLE = new RegExp(`^(?:${SEQUENCE})$`, 'u')
const ANY = new RegExp(SEQUENCE, 'u')

/** `text` is exactly one emoji sequence. */
export function isSingleEmojiSequence(text: string): boolean {
  return SINGLE.test(text)
}

/** `text` holds at least one emoji sequence. */
export function hasEmojiSequence(text: string): boolean {
  return ANY.test(text)
}

export interface EmojiRun {
  text: string
  /** One emoji sequence; otherwise text between sequences. */
  emoji: boolean
}

/** `text` cut into emoji sequences and the text between them; the runs join back to `text`. */
export function splitEmojiSequences(text: string): EmojiRun[] {
  const runs: EmojiRun[] = []
  const re = emojiSequenceRegex()
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), emoji: false })
    runs.push({ text: match[0], emoji: true })
    last = match.index + match[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last), emoji: false })
  return runs
}
