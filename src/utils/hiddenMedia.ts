/**
 * Message parts as shown for a server whose media this instance hides
 * (instance_server_blocks.media_hidden): every file and sticker part becomes one 'media_hidden'
 * part at the place of the first, and links render without inline media or previews.
 */
import type { MessagePart } from '@/types'

export interface MediaHiddenPart {
  type: 'media_hidden'
  count: number
}

export function withMediaHidden(parts: MessagePart[]): Array<MessagePart | MediaHiddenPart> {
  const out: Array<MessagePart | MediaHiddenPart> = []
  let notice: MediaHiddenPart | null = null
  for (const part of parts) {
    if (part && typeof part === 'object' && (part.type === 'file' || part.type === 'sticker')) {
      if (!notice) {
        notice = { type: 'media_hidden', count: 0 }
        out.push(notice)
      }
      notice.count += 1
      continue
    }
    if (part && typeof part === 'object' && part.type === 'url') {
      out.push({ ...part, preview: false } as MessagePart)
      continue
    }
    out.push(part)
  }
  return out
}
