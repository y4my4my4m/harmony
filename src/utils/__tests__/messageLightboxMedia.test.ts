import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@/types'
import { groupMediaGalleryParts } from '@/utils/mediaGalleryUtils'
import { chatLightboxEntries, chatMediaKey, type ChatLightboxHelpers } from '@/utils/messageLightboxMedia'

const helpers = (over: Partial<ChatLightboxHelpers> = {}): ChatLightboxHelpers => ({
  source: (part) => (part.path ? `https://signed.test/${part.path}` : part.url),
  imageAlt: (part) => (typeof part.altText === 'string' ? part.altText : 'no description'),
  videoAlt: (part) => (typeof part.altText === 'string' ? part.altText : ''),
  excluded: (part) => (part.url ?? '').includes('sticker') || (part.fileName ?? '').startsWith('SPOILER_'),
  embedMedia: () => null,
  gifAlt: 'GIF',
  ...over,
})

const file = (url: string, fileType: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'file', url, fileType, ...extra }) as unknown as MessagePart

describe('chatLightboxEntries', () => {
  it("lists a message's pictures and videos in display order, galleries included", () => {
    const parts = groupMediaGalleryParts([
      { type: 'text', text: 'look ' } as MessagePart,
      file('https://x.test/a.png', 'image', { altText: 'A cat', fileName: 'a.png' }),
      file('https://x.test/b.mp4', 'video', { fileName: 'b.mp4' }),
      { type: 'text', text: ' and ' } as MessagePart,
      file('https://x.test/c.webp', 'image'),
    ])
    const entries = chatLightboxEntries(parts, helpers())
    expect(entries.map((e) => e.media)).toEqual([
      { url: 'https://x.test/a.png', type: 'image', alt: 'A cat', name: 'a.png' },
      { url: 'https://x.test/b.mp4', type: 'video', alt: undefined, name: 'b.mp4' },
      { url: 'https://x.test/c.webp', type: 'image', alt: 'no description' },
    ])
    expect(entries.map((e) => e.key)).toEqual(['https://x.test/a.png', 'https://x.test/b.mp4', 'https://x.test/c.webp'])
  })

  it('names a private part by its object and plays its signed source', () => {
    const part = file('message-media://room/u/a.png', 'image', { path: 'room/u/a.png' })
    const [entry] = chatLightboxEntries([part], helpers())
    expect(entry.key).toBe('room/u/a.png')
    expect(chatMediaKey(part as never)).toBe('room/u/a.png')
    expect(entry.media.url).toBe('https://signed.test/room/u/a.png')
  })

  it('leaves out stickers, covered spoilers, audio and links shown as links', () => {
    const entries = chatLightboxEntries(
      [
        file('https://x.test/sticker.png', 'image'),
        file('https://x.test/s.png', 'image', { fileName: 'SPOILER_s.png' }),
        file('https://x.test/v.ogg', 'audio'),
        { type: 'url', url: 'https://x.test/linked.png', preview: false } as unknown as MessagePart,
        { type: 'url', url: 'https://x.test/shown.png' } as unknown as MessagePart,
      ],
      helpers(),
    )
    expect(entries.map((e) => e.key)).toEqual(['https://x.test/shown.png'])
  })

  it("adds an embed's GIF as a picture and its clip as a video", () => {
    const gif = { type: 'url', url: 'https://tenor.test/view/1' } as unknown as MessagePart
    const clip = { type: 'url', url: 'https://fixer.test/status/2' } as unknown as MessagePart
    const loop = { type: 'url', url: 'https://giphy.test/3' } as unknown as MessagePart
    const embeds = new Map<MessagePart, { kind: 'image' | 'video' | 'clip'; url: string }>([
      [gif, { kind: 'image', url: 'https://media.test/1.gif' }],
      [clip, { kind: 'clip', url: 'https://media.test/2.mp4' }],
      [loop, { kind: 'video', url: 'https://media.test/3.mp4' }],
    ])
    const entries = chatLightboxEntries([gif, clip, loop], helpers({ embedMedia: (part) => embeds.get(part) ?? null }))
    expect(entries.map((e) => e.media)).toEqual([
      { url: 'https://media.test/1.gif', type: 'image', alt: 'GIF' },
      { url: 'https://media.test/2.mp4', type: 'video', loop: false },
      { url: 'https://media.test/3.mp4', type: 'video', loop: true },
    ])
    expect(entries[1].key).toBe('https://media.test/2.mp4')
  })
})
