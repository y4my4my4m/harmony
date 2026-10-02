import { describe, it, expect } from 'vitest'
import { isHeartEmoji, isHeartReaction } from '../heartReaction'

describe('isHeartReaction', () => {
  it('holds for U+2764 and U+2665 with or without a variation selector', () => {
    for (const heart of ['\u2764', '\u2764\uFE0F', '\u2764\uFE0E', '\u2665', '\u2665\uFE0F', ' \u2764 ']) {
      expect(isHeartReaction(heart)).toBe(true)
    }
  })

  it('fails for the other hearts, shortcodes and empty input', () => {
    for (const other of ['💗', '💖', '🩷', '🧡', '👍', ':heart:', '', null, undefined]) {
      expect(isHeartReaction(other)).toBe(false)
    }
  })
})

describe('isHeartEmoji', () => {
  it('is the picker\'s unicode heart, sent as id or native', () => {
    expect(isHeartEmoji({ id: '\u2764\uFE0F', name: 'red_heart', url: '' } as any)).toBe(true)
    expect(isHeartEmoji({ native: '\u2764\uFE0F' })).toBe(true)
  })

  it('is not an emojis row, whose id is a uuid', () => {
    expect(isHeartEmoji({ id: '0b6e3c1e-9a43-4f7e-a1b2-3c4d5e6f7a8b' })).toBe(false)
  })

  it('is not an image emoji, whatever it is named', () => {
    expect(isHeartEmoji({ native: '\u2764', url: 'https://x.test/heart.png' })).toBe(false)
    expect(isHeartEmoji(null)).toBe(false)
  })
})
