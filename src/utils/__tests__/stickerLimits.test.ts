import { describe, expect, it } from 'vitest'
import { parseStickerCap, stickerLimitOf } from '@/utils/stickerLimits'

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
