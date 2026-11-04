/**
 * The emoji style chosen in Appearance (emojiPackService) is the pack message and composer
 * rendering follow (unifiedEmojiService): a saved System choice draws unicode emoji as text from
 * the first render, and a switch on either side reaches the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

async function load() {
  const { userStorage } = await import('@/utils/userScopedStorage')
  const packs = await import('@/services/emojiPackService')
  const unified = await import('@/services/unifiedEmojiService')
  return { userStorage, packs, unified }
}

describe('emoji style choice', () => {
  it('a saved System choice is the rendering pack from the first read', async () => {
    const { userStorage } = await import('@/utils/userScopedStorage')
    userStorage.setItem('emoji-pack', 'native')
    vi.resetModules()
    const { unified } = await load()
    const { isNativePack } = unified.useUnifiedEmoji()
    expect(isNativePack.value).toBe(true)
    expect(unified.resolveEmoji('😀').display).toEqual({ type: 'native', content: '😀' })
    expect(unified.twemojiFileUrl('😀')).toBeNull()
  })

  it('Twemoji is the default', async () => {
    const { unified } = await load()
    expect(unified.useUnifiedEmoji().isTwemojiPack.value).toBe(true)
  })

  it('a switch in Appearance reaches rendering, and a switch from a picker reaches Appearance', async () => {
    const { packs, unified, userStorage } = await load()
    const { isNativePack } = unified.useUnifiedEmoji()
    packs.setCurrentPack('native')
    expect(isNativePack.value).toBe(true)
    expect(unified.currentPack.value).toBe('native')

    unified.setEmojiPack('twemoji')
    expect(packs.currentPackId.value).toBe('twemoji')
    expect(userStorage.getItem('emoji-pack')).toBe('twemoji')
    expect(isNativePack.value).toBe(false)
  })

  it('the un-namespaced key unifiedEmojiService wrote is carried over once', async () => {
    localStorage.setItem('harmony-emoji-pack', 'native')
    const { unified, userStorage } = await load()
    expect(unified.useUnifiedEmoji().isNativePack.value).toBe(true)
    expect(userStorage.getItem('emoji-pack')).toBe('native')
    expect(localStorage.getItem('harmony-emoji-pack')).toBeNull()
  })
})
