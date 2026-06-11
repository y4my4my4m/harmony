import { describe, it, expect } from 'vitest'
import { extractHttpUrls } from '@/utils/urlSplitting'
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

describe('splitGluedUrlsInParts', () => {
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
