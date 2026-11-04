import { describe, expect, it } from 'vitest'
import { parseStickerCap, stickerLimitOf, stickerSectionListed } from '@/utils/stickerLimits'

describe('parseStickerCap', () => {
  it('mirrors sticker_limit()', () => {
    expect(parseStickerCap('server', 0)).toBe(0)
    expect(parseStickerCap('server', '7')).toBe(7)
    expect(parseStickerCap('server', 500)).toBe(100)
    expect(parseStickerCap('instance', 900)).toBe(500)
    expect(parseStickerCap('server', 'many')).toBe(15)
    expect(parseStickerCap('instance', -1)).toBe(50)
    expect(parseStickerCap('user', undefined)).toBe(0)
  })
})

describe('stickerLimitOf', () => {
  it('reads the cap of a STICKER_LIMIT refusal only', () => {
    expect(stickerLimitOf({ code: '23514', message: 'STICKER_LIMIT: at most 15 server stickers' })).toBe(15)
    expect(stickerLimitOf({ code: '23514', message: 'STICKER_PARTS: a message holds at most one sticker' })).toBeNull()
    expect(stickerLimitOf({ code: '22023', message: 'STICKER_LIMIT: at most 1' })).toBeNull()
  })
})

describe('stickerSectionListed', () => {
  it('lists a scope while its cap allows stickers or it still holds some', () => {
    expect(stickerSectionListed(15, null)).toBe(true)
    expect(stickerSectionListed(0, 2)).toBe(true)
    expect(stickerSectionListed(null, 1)).toBe(true)
    expect(stickerSectionListed(0, 0)).toBe(false)
  })

  it('is undecided until the cap, and with a cap of 0 the count, is known', () => {
    expect(stickerSectionListed(null, null)).toBeNull()
    expect(stickerSectionListed(0, null)).toBeNull()
    expect(stickerSectionListed(null, 0)).toBeNull()
  })
})
