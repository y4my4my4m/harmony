import { describe, it, expect } from 'vitest'
import { DEFAULT_PERSONAL_EMOJIS_PER_USER, parsePersonalEmojiLimit, personalEmojiLimitOf } from '../personalEmojiLimit'

// Same reading as personal_emoji_limit() in 20261016100004_personal_emoji_uploads.sql.
describe('parsePersonalEmojiLimit', () => {
  it('keeps 0, which turns personal emojis off', () => {
    expect(parsePersonalEmojiLimit(0)).toBe(0)
    expect(parsePersonalEmojiLimit('0')).toBe(0)
  })

  it('reads numbers and numeric strings, capped at 1000', () => {
    expect(parsePersonalEmojiLimit(1)).toBe(1)
    expect(parsePersonalEmojiLimit('25')).toBe(25)
    expect(parsePersonalEmojiLimit(5000)).toBe(1000)
  })

  it('falls back to the default for anything unusable', () => {
    for (const value of [null, undefined, '', 'many', -3, 2.5]) {
      expect(parsePersonalEmojiLimit(value)).toBe(DEFAULT_PERSONAL_EMOJIS_PER_USER)
    }
  })
})

describe('personalEmojiLimitOf', () => {
  it('reads the limit from the trigger refusal', () => {
    expect(personalEmojiLimitOf({ code: '23514', message: 'PERSONAL_EMOJI_LIMIT: at most 7 personal emojis per user' })).toBe(7)
  })

  it('is null for other errors', () => {
    expect(personalEmojiLimitOf(null)).toBeNull()
    expect(personalEmojiLimitOf({ code: '23514', message: 'REACTION_LIMIT: 10 reactions per person on a post' })).toBeNull()
    expect(personalEmojiLimitOf({ code: '42501', message: 'PERSONAL_EMOJI_LIMIT: at most 7' })).toBeNull()
  })
})
