import { describe, expect, it } from 'vitest'
import { isStoredMedia, mediaAspectRatio, withMediaEdits } from '@/utils/mediaEdit'

describe('withMediaEdits', () => {
  const row = { type: 'Image', url: 'https://s/u/posts/1.png', mediaType: 'image/png', name: 'IMG_1.png' }

  it('adds the description and Mastodon meta.focus', () => {
    expect(withMediaEdits(row, 'A cat', { x: 0.25, y: -0.5 })).toEqual({
      ...row,
      description: 'A cat',
      meta: { focus: { x: 0.25, y: -0.5 } },
    })
  })

  it('drops an emptied description and a centred focus, keeping other meta', () => {
    const stored = { ...row, description: 'old', meta: { width: 10, focus: { x: 0.5, y: 0.5 } } }
    expect(withMediaEdits(stored, '', { x: 0, y: 0 })).toEqual({ ...row, meta: { width: 10 } })
    expect(withMediaEdits({ ...row, meta: { focus: { x: 1, y: 1 } } }, '', null)).toEqual(row)
  })

  it('clamps the focus', () => {
    expect(withMediaEdits(row, '', { x: 3, y: -0.333 }).meta).toEqual({ focus: { x: 1, y: -0.33 } })
  })
})

describe('isStoredMedia', () => {
  it('holds for an uploaded attachment without a file', () => {
    expect(isStoredMedia({ type: 'image', url: 'https://s/1.png', stored: {} })).toBe(true)
  })

  it('does not hold for a picked file or a blob preview', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    expect(isStoredMedia(file)).toBe(false)
    expect(isStoredMedia({ type: 'image', url: 'blob:http://app/1', file })).toBe(false)
    expect(isStoredMedia({ type: 'image', url: 'https://s/1.png', file })).toBe(false)
    expect(isStoredMedia(null)).toBe(false)
  })
})

describe('mediaAspectRatio', () => {
  it('follows the turned image for original and is fixed otherwise', () => {
    const size = { width: 400, height: 300 }
    expect(mediaAspectRatio('original', size, 0)).toBeCloseTo(4 / 3)
    expect(mediaAspectRatio('original', size, 90)).toBeCloseTo(3 / 4)
    expect(mediaAspectRatio('square', size, 90)).toBe(1)
    expect(mediaAspectRatio('16:9', size, 0)).toBeCloseTo(16 / 9)
    expect(mediaAspectRatio('4:3', size, 270)).toBeCloseTo(4 / 3)
  })
})
