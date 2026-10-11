// Short spoken forms of chat messages, for live announcements. Spoilers and
// encrypted bodies are never spoken; attachments are named by kind and their
// description.

import type { MessagePart } from '@/types'
import { customEmojiLabel } from './emojiNames'

export type Translate = (key: string, params?: Record<string, unknown>, plural?: number) => string

/** Characters of message text kept in an announcement. */
export const SPOKEN_TEXT_MAX = 160

const SPOILER = /\|\|(?=\S)[\s\S]*?\S\|\|/g

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/** The message as one line of speech; '' when nothing speakable remains. */
export function messageSpeechText(
  parts: MessagePart[] | null | undefined,
  t: Translate,
  options: { encrypted?: boolean; max?: number } = {},
): string {
  if (options.encrypted) return t('messageA11y.speech.encrypted')
  if (!Array.isArray(parts)) return ''
  const pieces: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as MessagePart & Record<string, any>
    switch (p.type) {
      case 'text':
        if (p.text) pieces.push(String(p.text).replace(SPOILER, ` ${t('messageA11y.speech.spoiler')} `))
        break
      case 'emoji':
        pieces.push(customEmojiLabel(p.emoji?.name))
        break
      case 'mention':
        pieces.push(`@${p.username ?? ''}`)
        break
      case 'role_mention':
        pieces.push(`@${String(p.roleName ?? '').replace(/^@/, '')}`)
        break
      case 'channel_mention':
        pieces.push(`#${p.name ?? ''}`)
        break
      case 'hashtag':
        pieces.push(`#${p.name ?? ''}`)
        break
      case 'url':
        pieces.push(p.url ?? '')
        break
      case 'file': {
        const alt = typeof p.altText === 'string' ? p.altText.trim() : ''
        if (p.fileType === 'image') pieces.push(alt ? t('messageA11y.speech.imageWithAlt', { alt }) : t('messageA11y.speech.image'))
        else if (p.fileType === 'video') pieces.push(alt ? t('messageA11y.speech.videoWithAlt', { alt }) : t('messageA11y.speech.video'))
        else if (p.fileType === 'audio') pieces.push(t('messageA11y.speech.audio'))
        else pieces.push(t('messageA11y.speech.file', { name: p.fileName ?? '' }))
        break
      }
      case 'poll':
        pieces.push(t('messageA11y.speech.poll', { question: p.question ?? '' }))
        break
    }
  }
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
  return truncate(text, options.max ?? SPOKEN_TEXT_MAX)
}

export interface IncomingMessage {
  authorName: string
  text: string
}

/** Names listed in a burst summary before "N others". */
const NAMES_LISTED = 3

/**
 * One announcement for a burst of incoming messages: "Alice: hi" for one,
 * "3 new messages from Alice, Bob" for several.
 */
export function summarizeIncoming(items: IncomingMessage[], t: Translate): string {
  if (items.length === 0) return ''
  if (items.length === 1) {
    const { authorName, text } = items[0]
    return text
      ? t('messageA11y.announce.one', { name: authorName, text })
      : t('messageA11y.announce.oneEmpty', { name: authorName })
  }
  const names = [...new Set(items.map((item) => item.authorName).filter(Boolean))]
  const listed = names.slice(0, NAMES_LISTED).join(', ')
  const rest = names.length - NAMES_LISTED
  const from = rest > 0 ? t('messageA11y.announce.andOthers', { names: listed, count: rest }, rest) : listed
  return t('messageA11y.announce.many', { count: items.length, names: from }, items.length)
}
