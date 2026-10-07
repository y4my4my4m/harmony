import { describe, expect, it } from 'vitest'
import {
  attachmentFocus,
  attachmentObjectPosition,
  clampFocus,
  focusFromFocalPoint,
  focusFromNormalized,
  focusToFocalPoint,
  focusToNormalized,
  focusToObjectPosition,
  isCentredFocus,
} from '@/utils/focalPoint'

describe('focus and normalized units', () => {
  it('maps the corners: y is up-positive, normalized y is down', () => {
    expect(focusFromNormalized({ x: 0, y: 0 })).toEqual({ x: -1, y: 1 })
    expect(focusFromNormalized({ x: 1, y: 1 })).toEqual({ x: 1, y: -1 })
    expect(focusFromNormalized({ x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0 })
    expect(focusToNormalized({ x: -1, y: 1 })).toEqual({ x: 0, y: 0 })
    expect(focusToNormalized({ x: 1, y: -1 })).toEqual({ x: 1, y: 1 })
  })

  it('round-trips at Mastodon precision', () => {
    const focus = focusFromNormalized({ x: 0.8, y: 0.25 })
    expect(focus).toEqual({ x: 0.6, y: 0.5 })
    expect(focusToNormalized(focus)).toEqual({ x: 0.8, y: 0.25 })
  })

  it('clamps to [-1, 1] and rounds to two decimals', () => {
    expect(clampFocus({ x: 1.7, y: -3 })).toEqual({ x: 1, y: -1 })
    expect(clampFocus({ x: 0.12345, y: -0.6789 })).toEqual({ x: 0.12, y: -0.68 })
    expect(Object.is(clampFocus({ x: -0.001, y: 0 }).x, 0)).toBe(true)
  })

  it('treats a missing or zero focus as centred', () => {
    expect(isCentredFocus(null)).toBe(true)
    expect(isCentredFocus({ x: 0, y: 0 })).toBe(true)
    expect(isCentredFocus({ x: 0, y: 0.1 })).toBe(false)
  })
})

describe('object-position', () => {
  it('is ((x + 1) / 2, (1 - y) / 2) in percent', () => {
    expect(focusToObjectPosition({ x: 0, y: 0 })).toBe('50% 50%')
    expect(focusToObjectPosition({ x: -1, y: 1 })).toBe('0% 0%')
    expect(focusToObjectPosition({ x: 1, y: -1 })).toBe('100% 100%')
    expect(focusToObjectPosition({ x: 0.5, y: 0.5 })).toBe('75% 25%')
    expect(focusToObjectPosition({ x: -0.33, y: -0.42 })).toBe('33.5% 71%')
  })
})

describe('ActivityPub focalPoint', () => {
  it('serializes [x, y] from focus', () => {
    expect(focusToFocalPoint({ x: 0.25, y: -0.5 })).toEqual([0.25, -0.5])
    expect(focusToFocalPoint({ x: 2, y: 0.333 })).toEqual([1, 0.33])
  })

  it('parses arrays, expanded lists and numeric strings', () => {
    expect(focusFromFocalPoint([0.25, -0.5])).toEqual({ x: 0.25, y: -0.5 })
    expect(focusFromFocalPoint({ '@list': [-0.1, 0.9] })).toEqual({ x: -0.1, y: 0.9 })
    expect(focusFromFocalPoint(['0.5', '0.5'])).toEqual({ x: 0.5, y: 0.5 })
  })

  it('rejects malformed values', () => {
    for (const bad of [null, undefined, 'a', [], [1], [NaN, 0], ['x', 0], { x: 0, y: 0 }, { '@list': [1] }]) {
      expect(focusFromFocalPoint(bad)).toBeNull()
    }
  })
})

describe('attachmentFocus', () => {
  it('reads meta.focus from composer rows and Mastodon API attachments', () => {
    expect(attachmentFocus({ type: 'Image', url: 'u', meta: { focus: { x: 0.3, y: -0.2 } } })).toEqual({ x: 0.3, y: -0.2 })
  })

  it('reads focalPoint from ActivityPub copies and content file parts', () => {
    expect(attachmentFocus({ type: 'file', url: 'u', focalPoint: [-0.5, 0.5] })).toEqual({ x: -0.5, y: 0.5 })
  })

  it('reads a composer focus', () => {
    expect(attachmentFocus({ url: 'blob:x', focus: { x: 1, y: 1 } })).toEqual({ x: 1, y: 1 })
  })

  it('is null without a usable focus', () => {
    expect(attachmentFocus({ url: 'u' })).toBeNull()
    expect(attachmentFocus({ url: 'u', meta: { focus: { x: 'left' } } })).toBeNull()
    expect(attachmentFocus(null)).toBeNull()
  })

  it('attachmentObjectPosition skips the centre', () => {
    expect(attachmentObjectPosition({ focalPoint: [0, 0] })).toBeNull()
    expect(attachmentObjectPosition({ focalPoint: [0.5, 0.5] })).toBe('75% 25%')
  })
})
