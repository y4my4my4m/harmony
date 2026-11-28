import { messagePartsToPlainText } from '@/utils/messageContentUtils'
import { maskSpoilers } from '@/utils/spoiler'
import type { MessagePart } from '@/types'

export interface PreviewEmoji { name: string; url: string }
/** One line of a message as it is drawn: text, or a custom emoji. */
export type PreviewRun = { text: string; emoji: null } | { text: ''; emoji: PreviewEmoji }

// Postgres text holds no NUL: no stored message spells an emoji's mark.
const EMOJI_MARK = /\0(\d+)\0/

export function textRun(text: string): PreviewRun {
  return { text, emoji: null }
}

/** The runs of a line `write` makes, which spells each custom emoji as the function it is given does. */
export function emojiRuns(write: (emojiText: (emoji: { name?: string; url?: string } | undefined) => string) => string): PreviewRun[] {
  const emojis: PreviewEmoji[] = []
  const line = write((emoji) => {
    if (!emoji?.url) return emoji?.name ? `:${emoji.name}:` : ''
    emojis.push({ name: emoji.name || '', url: emoji.url })
    return `\0${emojis.length - 1}\0`
  })
  // The capture group puts each mark's number between the texts beside it.
  return line.split(EMOJI_MARK).flatMap((piece, index): PreviewRun[] => {
    if (index % 2) return emojis[Number(piece)] ? [{ text: '', emoji: emojis[Number(piece)] }] : []
    return piece ? [textRun(piece)] : []
  })
}

/** A message's text with spoilers masked, and its custom emojis outside them. */
export function messagePreviewRuns(content: MessagePart[]): PreviewRun[] {
  return emojiRuns((emojiText) => maskSpoilers(messagePartsToPlainText(content, emojiText)))
}

/** At most `limit` characters, an emoji counting as one; a cut text ends in …. */
export function cutRuns(runs: PreviewRun[], limit: number): PreviewRun[] {
  const kept: PreviewRun[] = []
  let left = limit
  for (const run of runs) {
    const length = run.emoji ? 1 : run.text.length
    if (length <= left) {
      kept.push(run)
      left -= length
      continue
    }
    kept.push(textRun(`${run.emoji ? '' : run.text.slice(0, left)}…`))
    break
  }
  return kept
}

/** The line as text, for names and labels. */
export function runsText(runs: PreviewRun[]): string {
  return runs.map((run) => (run.emoji ? `:${run.emoji.name}:` : run.text)).join('')
}
