import { describe, it, expect } from 'vitest'
import { personalEmojiLimitMessage, personalEmojiLimitOf } from '../personalEmojiLimit.js'

describe('personalEmojiLimitOf', () => {
  it('reads the limit from a PERSONAL_EMOJI_LIMIT refusal', () => {
    expect(personalEmojiLimitOf({ code: '23514', message: 'PERSONAL_EMOJI_LIMIT: at most 25 personal emojis per user' })).toBe(25)
    expect(personalEmojiLimitOf({ code: '23514', message: 'PERSONAL_EMOJI_LIMIT: at most 0 personal emojis per user' })).toBe(0)
  })

  it('is null for any other error', () => {
    expect(personalEmojiLimitOf(null)).toBeNull()
    expect(personalEmojiLimitOf({ code: '23514', message: 'REACTION_LIMIT: 20 different emoji per message' })).toBeNull()
    expect(personalEmojiLimitOf({ code: '23505', message: 'PERSONAL_EMOJI_LIMIT: at most 5' })).toBeNull()
  })
})

describe('personalEmojiLimitMessage', () => {
  it('names the limit and where to make room', () => {
    expect(personalEmojiLimitMessage(3)).toBe(
      "You have reached this instance's limit of 3 personal emojis. Delete one in Settings > My emojis to make room.",
    )
  })

  it('says personal emojis are off at 0', () => {
    expect(personalEmojiLimitMessage(0)).toBe('Personal emojis are turned off on this instance.')
  })
})
