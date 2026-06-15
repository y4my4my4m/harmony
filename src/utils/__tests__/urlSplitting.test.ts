import { describe, it, expect } from 'vitest'
import {
  extractHttpUrls,
  isPureGluedUrlBlob,
  parseUrlMatchContext,
  splitTextForUrlParts,
} from '@/utils/urlSplitting'
import { splitGluedUrlsInParts, groupMediaGalleryParts } from '@/utils/mediaGalleryUtils'

describe('extractHttpUrls', () => {
  it('splits glued image URLs without separators', () => {
    const a = 'https://db.example.com/a.png'
    const b = 'https://db.example.com/b.png'
    const c = 'https://db.example.com/c.png'
    const glued = `${a}${b}${c}`
    expect(extractHttpUrls(glued)).toEqual([a, b, c])
  })

  it('still parses a single URL', () => {
    const url = 'https://example.com/file.png'
    expect(extractHttpUrls(url)).toEqual([url])
  })

  it('parses space-separated URLs', () => {
    const parts = extractHttpUrls('see https://a.com/x.png and https://b.com/y.jpg ok')
    expect(parts).toEqual(['https://a.com/x.png', 'https://b.com/y.jpg'])
  })
})

describe('parseUrlMatchContext / splitTextForUrlParts', () => {
  it('suppresses preview for angle-bracket URLs and omits brackets', () => {
    const text = 'see <https://example.com> ok'
    const parts = splitTextForUrlParts(text)
    expect(parts).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'url', url: 'https://example.com', preview: false },
      { type: 'text', text: ' ok' },
    ])
  })

  it('parseUrlMatchContext detects bracket wrap at match site', () => {
    const text = '<https://a.com>'
    const idx = text.indexOf('https')
    const ctx = parseUrlMatchContext(text, idx, 'https://a.com'.length)
    expect(ctx).toMatchObject({
      url: 'https://a.com',
      preview: false,
      segmentStart: 0,
      segmentEnd: text.length,
    })
  })
})

describe('isPureGluedUrlBlob', () => {
  it('is false when angle brackets are present', () => {
    expect(isPureGluedUrlBlob('<https://a.com>https://b.com')).toBe(false)
    expect(isPureGluedUrlBlob('see <https://a.com>')).toBe(false)
  })
})

describe('splitGluedUrlsInParts', () => {
  it('does not rewrite prose with angle-bracket URLs', () => {
    const input = [{ type: 'text', text: 'see <https://example.com> ok' }] as any
    expect(splitGluedUrlsInParts(input)).toEqual(input)
  })

  it('does not strip preview:false from existing url parts', () => {
    const input = [{ type: 'url', url: 'https://example.com', preview: false }] as any
    expect(splitGluedUrlsInParts(input)).toEqual(input)
  })
  it('turns a glued url part into separate file parts', () => {
    const a = 'https://db.example.com/a.png'
    const b = 'https://db.example.com/b.png'
    const parts = splitGluedUrlsInParts([
      { type: 'file', url: a, fileType: 'image' },
      { type: 'url', url: `${b}https://db.example.com/c.png` },
    ] as any)

    const imageUrls = parts
      .filter((p) => p.type === 'file' || p.type === 'url')
      .map((p: any) => p.url)

    expect(imageUrls).toEqual([a, b, 'https://db.example.com/c.png'])
  })
})

describe('groupMediaGalleryParts', () => {
  it('groups consecutive image file parts into media_gallery', () => {
    const grouped = groupMediaGalleryParts([
      { type: 'text', text: 'hi' },
      { type: 'file', url: 'https://a/1.png', fileType: 'image' },
      { type: 'file', url: 'https://a/2.png', fileType: 'image' },
    ] as any)

    expect(grouped[0]).toMatchObject({ type: 'text', text: 'hi' })
    expect(grouped[1]).toMatchObject({ type: 'media_gallery' })
    expect((grouped[1] as any).parts).toHaveLength(2)
  })
})
