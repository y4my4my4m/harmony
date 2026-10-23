/**
 * customEmojiIndex / pickCustomEmoji: a name a default emoji answers to leaves the bare
 * `:name:` to the default, and its custom emoji are name~1, name~2; any other name is its
 * first custom emoji, and name~1 the second.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/unifiedEmojiService', () => ({
  getSvgUrl: vi.fn(),
  resolveEmoji: vi.fn(),
  getTwemojiUrl: vi.fn(),
  loadEmojiData: vi.fn(),
  isLoaded: { value: true },
  isDefaultShortcode: (name: string) => name === 'fire' || name === 'thumbs_up',
}))

const { customEmojiIndex, pickCustomEmoji, parseEmojiShortcodeToken } = await import('@/services/emojiShortcodeResolver')

describe('custom emoji index of a token', () => {
  it('gives the bare name of a default emoji to the default', () => {
    expect(customEmojiIndex(parseEmojiShortcodeToken('fire'))).toBeNull()
    expect(customEmojiIndex(parseEmojiShortcodeToken('fire~1'))).toBe(0)
    expect(customEmojiIndex(parseEmojiShortcodeToken('fire~2'))).toBe(1)
  })

  it('gives the bare name of any other name to its first custom emoji', () => {
    expect(customEmojiIndex(parseEmojiShortcodeToken('pog'))).toBe(0)
    expect(customEmojiIndex(parseEmojiShortcodeToken('pog~1'))).toBe(1)
  })

  it('picks from a list, the default meaning no custom emoji', () => {
    const list = ['first', 'second']
    expect(pickCustomEmoji(list, parseEmojiShortcodeToken('fire'))).toBeNull()
    expect(pickCustomEmoji(list, parseEmojiShortcodeToken('fire~1'))).toBe('first')
    expect(pickCustomEmoji(list, parseEmojiShortcodeToken('pog'))).toBe('first')
    expect(pickCustomEmoji(list, parseEmojiShortcodeToken('pog~1'))).toBe('second')
    expect(pickCustomEmoji(list, parseEmojiShortcodeToken('pog~9'))).toBe('first')
  })
})
