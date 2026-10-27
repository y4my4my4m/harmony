import { describe, expect, it, vi } from 'vitest'

// Sticker parts over federation: rawContent normalization, DM harmony:sticker, attachment alt text.

vi.mock('../../config/index.js', () => {
  const cfg = {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://kong:8000',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  }
  return { default: cfg, config: cfg }
})

import {
  normalizeInboundStickers,
  sanitizeSticker,
  stickerNoteExtension,
  withInboundSticker,
} from '../stickers.js'
import { inboundRawContent } from '../inboundContent.js'
import { fileAttachmentsToAp } from '../privateMedia.js'

const URL_A = 'https://peer.test/storage/v1/object/public/stickers/server/a/1.png'
const sticker = (over: Record<string, unknown> = {}) => ({
  type: 'sticker', id: 's1', url: URL_A, name: 'Cat wave', description: 'A cat waving', width: 160, height: 120, mimeType: 'image/png', ...over,
})
const fallback = (over: Record<string, unknown> = {}) => ({
  type: 'file', fileType: 'image', url: URL_A, fileName: 'Cat wave', altText: 'A cat waving', stickerId: 's1', ...over,
})

describe('sanitizeSticker', () => {
  it('marks a sticker with the instance it came from', () => {
    expect(sanitizeSticker(sticker(), 'peer.test')).toEqual({ ...sticker(), domain: 'peer.test' })
  })

  it('keeps a claimed domain, and drops one naming this instance', () => {
    expect(sanitizeSticker(sticker({ domain: 'third.test' }), 'peer.test')?.domain).toBe('third.test')
    expect(sanitizeSticker(sticker({ domain: 'harmony.test' }), 'peer.test')).not.toHaveProperty('domain')
  })

  it('cuts name and description to 30 and 300 characters', () => {
    const cut = sanitizeSticker(sticker({ name: 'n'.repeat(40), description: 'd'.repeat(400) }), 'peer.test')
    expect(cut?.name).toHaveLength(30)
    expect(cut?.description).toHaveLength(300)
  })

  it('refuses a sticker without a description, an http(s) url or an id', () => {
    expect(sanitizeSticker(sticker({ description: '  ' }), 'peer.test')).toBeNull()
    expect(sanitizeSticker(sticker({ url: 'javascript:alert(1)' }), 'peer.test')).toBeNull()
    expect(sanitizeSticker(sticker({ id: '' }), 'peer.test')).toBeNull()
  })
})

describe('normalizeInboundStickers', () => {
  it('keeps one sticker and its fallback; a second sticker is dropped and its image kept plain', () => {
    const URL_B = 'https://peer.test/b.png'
    const out = normalizeInboundStickers([
      sticker(), fallback(),
      sticker({ id: 's2', url: URL_B }), fallback({ url: URL_B, stickerId: 's2' }),
    ], 'peer.test')
    expect(out).toEqual([
      { ...sticker(), domain: 'peer.test' },
      fallback(),
      { type: 'file', fileType: 'image', url: URL_B, fileName: 'Cat wave', altText: 'A cat waving' },
    ])
  })

  it('turns the fallback of a malformed sticker into a plain image', () => {
    expect(normalizeInboundStickers([sticker({ description: '' }), fallback()], 'peer.test'))
      .toEqual([{ type: 'file', fileType: 'image', url: URL_A, fileName: 'Cat wave', altText: 'A cat waving' }])
  })

  it('runs in the rawContent path with the other inbound rules', () => {
    const out = inboundRawContent([{ type: 'text', text: 'hi ' }, sticker(), fallback({ path: 'x/y.png' })], 'peer.test')
    expect(out[1]).toMatchObject({ type: 'sticker', domain: 'peer.test' })
    expect(out[2]).not.toHaveProperty('path')
  })
})

describe('DM stickers', () => {
  it('names the sticker beside the attachment on an outbound Note', () => {
    expect(stickerNoteExtension([{ type: 'text', text: 'x' }, sticker(), fallback()])).toEqual({
      id: 's1', url: URL_A, name: 'Cat wave', description: 'A cat waving', width: 160, height: 120, mediaType: 'image/png',
    })
    expect(stickerNoteExtension([{ type: 'text', text: 'x' }])).toBeUndefined()
  })

  it('rebuilds the sticker from harmony:sticker and the attachment at its url', () => {
    const fromHtml = [{ type: 'text', text: 'look' }, { type: 'file', fileType: 'image', url: URL_A, altText: 'A cat waving' }]
    const ext = stickerNoteExtension([sticker()])
    expect(withInboundSticker(fromHtml, ext, 'peer.test')).toEqual([
      { type: 'text', text: 'look' },
      { ...sticker(), domain: 'peer.test' },
      { type: 'file', fileType: 'image', url: URL_A, altText: 'A cat waving', stickerId: 's1' },
    ])
  })

  it('leaves a Note from software without harmony:sticker, or without the attachment, as it is', () => {
    const fromHtml = [{ type: 'file', fileType: 'image', url: URL_A }]
    expect(withInboundSticker(fromHtml, undefined, 'peer.test')).toBe(fromHtml)
    expect(withInboundSticker([], stickerNoteExtension([sticker()]), 'peer.test')).toEqual([])
  })
})

describe('fileAttachmentsToAp', () => {
  it('names a sticker image by its description, other files by their name', () => {
    const out = fileAttachmentsToAp([sticker(), fallback(), { type: 'file', fileType: 'image', url: 'https://h.test/p.png', fileName: 'p.png', altText: 'x' }], 'peer.test')
    expect(out).toEqual([
      { type: 'Document', mediaType: 'image/png', url: URL_A, name: 'A cat waving' },
      { type: 'Document', mediaType: 'image/png', url: 'https://h.test/p.png', name: 'p.png' },
    ])
  })
})
