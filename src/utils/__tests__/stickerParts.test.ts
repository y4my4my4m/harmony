import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@/types'
import {
  isStickerFallback,
  messageSticker,
  stickerMessageParts,
  withoutStickerFallbacks,
} from '@/utils/stickerParts'
import { withMediaHidden } from '@/utils/hiddenMedia'
import { messagePartsToPlainText } from '@/utils/messageContentUtils'
import { messageSpeechText } from '@/utils/a11y/messageSpeech'

const sticker = {
  id: 's1',
  url: 'https://h.test/storage/v1/object/public/stickers/server/a/b.png',
  name: 'Cat wave',
  description: 'A cat waving',
  width: 160,
  height: 120,
  mime_type: 'image/png',
}

describe('stickerMessageParts', () => {
  it('is the sticker, then an image fallback named by the sticker and described by its alt text', () => {
    expect(stickerMessageParts(sticker)).toEqual([
      { type: 'sticker', id: 's1', url: sticker.url, name: 'Cat wave', description: 'A cat waving', width: 160, height: 120, mimeType: 'image/png' },
      { type: 'file', fileType: 'image', url: sticker.url, fileName: 'Cat wave', altText: 'A cat waving', stickerId: 's1', width: 160, height: 120, mimeType: 'image/png' },
    ])
  })
})

describe('withoutStickerFallbacks', () => {
  const parts = [{ type: 'text', text: 'hi ' } as MessagePart, ...stickerMessageParts(sticker)]

  it('hides the image of a sticker in the message', () => {
    expect(withoutStickerFallbacks(parts).map((p) => p.type)).toEqual(['text', 'sticker'])
    expect(isStickerFallback(parts[2], parts)).toBe(true)
    expect(messageSticker(parts)?.id).toBe('s1')
  })

  it('keeps the image when the sticker part is gone, as after an older client edits the message', () => {
    const edited = [parts[0], parts[2]]
    expect(withoutStickerFallbacks(edited)).toEqual(edited)
    expect(isStickerFallback(parts[2], edited)).toBe(false)
  })

  it('shows a file part naming the sticker that is not its image: another url, or not an image', () => {
    const other = { ...parts[2], url: 'https://elsewhere.test/hidden.png' } as MessagePart
    const video = { ...parts[2], fileType: 'video' } as MessagePart
    const forged = [parts[0], parts[1], other, video]
    expect(isStickerFallback(other, forged)).toBe(false)
    expect(isStickerFallback(video, forged)).toBe(false)
    expect(withoutStickerFallbacks(forged).map((p) => p.type)).toEqual(['text', 'sticker', 'file', 'file'])
  })

  it('returns content without stickers unchanged', () => {
    const plain = [{ type: 'text', text: 'x' } as MessagePart]
    expect(withoutStickerFallbacks(plain)).toBe(plain)
  })
})

describe('sticker text forms', () => {
  const parts = [{ type: 'text', text: 'look ' } as MessagePart, ...stickerMessageParts(sticker)]

  it('previews the sticker by name, without the image placeholder', () => {
    expect(messagePartsToPlainText(parts)).toBe('look [sticker: Cat wave]')
  })

  it('speaks the sticker with its description once', () => {
    const t = (key: string, p?: Record<string, unknown>) => `${key}(${JSON.stringify(p ?? {})})`
    const spoken = messageSpeechText(parts, t)
    expect(spoken).toContain('messageA11y.speech.sticker({"name":"Cat wave","description":"A cat waving"})')
    expect(spoken).not.toContain('imageWithAlt')
  })

  it('hides a sticker with the media of a hidden server', () => {
    const hidden = withMediaHidden(withoutStickerFallbacks(parts))
    expect(hidden).toEqual([{ type: 'text', text: 'look ' }, { type: 'media_hidden', count: 1 }])
  })
})
