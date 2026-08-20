import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'har.mony.lol' },
}))
vi.mock('../../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))

const { stripOwnEmojiDomain } = await import('../emojiResolvers.js')

// A reaction this instance emitted federates out and returns qualified with our own domain.
// The ingest dedupe compares the shortcode literally, so `:vibingcat@har.mony.lol:` alongside
// the stored `:vibingcat:` persisted both and split the chip.
describe('stripOwnEmojiDomain', () => {
  it('strips this instance from a qualified shortcode', () => {
    expect(stripOwnEmojiDomain(':vibingcat@har.mony.lol:')).toBe(':vibingcat:')
  })

  it('is case-insensitive on the domain', () => {
    expect(stripOwnEmojiDomain(':vibingcat@HAR.MONY.LOL:')).toBe(':vibingcat:')
  })

  it('leaves another instance qualified, since that emoji is genuinely theirs', () => {
    expect(stripOwnEmojiDomain(':vibingcat@spacify.cloud:')).toBe(':vibingcat@spacify.cloud:')
  })

  it('passes through an unqualified shortcode and a unicode char', () => {
    expect(stripOwnEmojiDomain(':vibingcat:')).toBe(':vibingcat:')
    expect(stripOwnEmojiDomain('🔥')).toBe('🔥')
  })

  it('passes through null and empty', () => {
    expect(stripOwnEmojiDomain(null)).toBeNull()
    expect(stripOwnEmojiDomain('')).toBe('')
  })
})
