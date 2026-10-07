/**
 * Bridged Discord reactions: metadata.remote_emoji_url is rendered as stored (animated .gif
 * included) when it is on Discord's CDN; any other host falls back to the identifier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

import { discordCdnUrl, remoteReactionEmojiUrl } from '@/utils/emojiUtils'
import { useReactionsStore } from '@/stores/useReactions'
import { CoreMessageService } from '@/services/core/CoreMessageService'

const PARTY = 'discord:party:1234567890'
const GIF = 'https://cdn.discordapp.com/emojis/1234567890.gif'
const PNG = 'https://cdn.discordapp.com/emojis/1234567890.png'
const TRACKER = 'https://tracker.example/pixel.gif'
const CUSTOM_ID = '00000000-0000-4000-8000-0000000000e1'

describe('remoteReactionEmojiUrl', () => {
  it('keeps an https Discord CDN url, animated included', () => {
    expect(remoteReactionEmojiUrl(PARTY, GIF)).toBe(GIF)
    expect(remoteReactionEmojiUrl(PARTY, 'https://media.discordapp.net/emojis/1.webp?size=48')).toBe(
      'https://media.discordapp.net/emojis/1.webp?size=48',
    )
  })

  it('rebuilds the .png of a Discord identifier when the url is absent or off the CDN', () => {
    expect(remoteReactionEmojiUrl(PARTY, null)).toBe(PNG)
    expect(remoteReactionEmojiUrl(PARTY, TRACKER)).toBe(PNG)
    expect(remoteReactionEmojiUrl(PARTY, 'http://cdn.discordapp.com/emojis/1.gif')).toBe(PNG)
    expect(remoteReactionEmojiUrl(PARTY, 'https://cdn.discordapp.com.evil.example/emojis/1.gif')).toBe(PNG)
  })

  it('gives a unicode reaction no image', () => {
    expect(remoteReactionEmojiUrl('🎉', TRACKER)).toBeNull()
    expect(remoteReactionEmojiUrl('🎉', undefined)).toBeNull()
    expect(discordCdnUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('realtime reaction from the bridge', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function payload(extra: Record<string, unknown>) {
    return {
      type: 'reaction:insert',
      op: 'INSERT',
      reaction_id: 'r1',
      message_id: 'm1',
      emoji_id: null,
      emoji_name: 'party',
      custom_emoji_content: PARTY,
      user_id: null,
      bot_id: 'bridge-bot',
      username: 'dana',
      display_name: 'Dana',
      ...extra,
    }
  }

  async function chipUrl(extra: Record<string, unknown>) {
    const store = useReactionsStore()
    store.bulkSetReactions({ m1: [] })
    await store.handleRealtimeUpdate(payload(extra))
    return store.getMessageReactions('m1')[0]?.emoji?.url
  }

  it('renders the animated url the bridge stored', async () => {
    expect(await chipUrl({ emoji_url: GIF, metadata: { remote_emoji_url: GIF, discord_user: { id: '8' } } })).toBe(GIF)
  })

  it('reads metadata.remote_emoji_url when the payload carries no emoji_url', async () => {
    expect(await chipUrl({ metadata: { remote_emoji_url: GIF, discord_user: { id: '8' } } })).toBe(GIF)
  })

  it('falls back to the identifier for a url off Discord\'s CDN', async () => {
    expect(await chipUrl({ emoji_url: TRACKER, metadata: { remote_emoji_url: TRACKER } })).toBe(PNG)
  })

  it('renders no image for a unicode reaction carrying a foreign url', async () => {
    const url = await chipUrl({ custom_emoji_content: '🎉', emoji_name: '🎉', emoji_url: TRACKER, metadata: { remote_emoji_url: TRACKER } })
    expect(url).not.toBe(TRACKER)
  })
})

describe('reaction rows from the server', () => {
  const service = new CoreMessageService()

  it('keeps a Discord CDN gif, drops a foreign url, and leaves custom emoji urls alone', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: [
        { message_id: 'm1', emoji_id: null, custom_emoji_content: PARTY, emoji_name: 'party', emoji_url: GIF, reaction_count: 1, users: [] },
        { message_id: 'm1', emoji_id: null, custom_emoji_content: 'discord:wave:42', emoji_name: 'wave', emoji_url: TRACKER, reaction_count: 1, users: [] },
        { message_id: 'm1', emoji_id: null, custom_emoji_content: '🎉', emoji_name: '🎉', emoji_url: TRACKER, reaction_count: 1, users: [] },
        { message_id: 'm1', emoji_id: CUSTOM_ID, custom_emoji_content: null, emoji_name: 'blobcat', emoji_url: 'https://remote.example/blobcat.png', reaction_count: 1, users: [] },
      ],
      error: null,
    } as never)

    const groups = (await service.getBatchMessageReactions(['m1'])).m1

    expect(groups.map((g) => [g.emoji.url, g.emoji.is_native])).toEqual([
      [GIF, false],
      ['https://cdn.discordapp.com/emojis/42.png', false],
      ['', true],
      ['https://remote.example/blobcat.png', false],
    ])
  })

  it('applies the same rule to a single message\'s groups', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: [
        { count: 1, emoji: { id: PARTY, name: 'party', url: GIF, content: PARTY, is_native: false }, reactions: [] },
        { count: 1, emoji: { id: '🎉', name: '🎉', url: TRACKER, content: '🎉', is_native: false }, reactions: [] },
        { count: 1, emoji: { id: CUSTOM_ID, name: 'blobcat', url: 'https://remote.example/blobcat.png', is_native: false }, reactions: [] },
      ],
      error: null,
    } as never)

    const groups = await service.getMessageReactions('m1')

    expect(groups.map((g) => [g.emoji.url, g.emoji.is_native])).toEqual([
      [GIF, false],
      ['', true],
      ['https://remote.example/blobcat.png', false],
    ])
  })
})
