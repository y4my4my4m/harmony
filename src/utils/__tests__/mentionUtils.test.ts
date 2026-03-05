import { describe, it, expect } from 'vitest'
import { extractMentions, parseBioWithEmojis, generateMentionTags, getDeliveryInboxes } from '@/utils/mentionUtils'

describe('mentionUtils', () => {
  describe('extractMentions', () => {
    it('extracts local mention', () => {
      const mentions = extractMentions('Hello @alice how are you?')
      expect(mentions).toHaveLength(1)
      expect(mentions[0].username).toBe('alice')
      expect(mentions[0].domain).toBeUndefined()
      expect(mentions[0].full).toBe('@alice')
    })

    it('extracts remote mention with domain', () => {
      const mentions = extractMentions('Hello @bob@mastodon.social')
      expect(mentions).toHaveLength(1)
      expect(mentions[0].username).toBe('bob')
      expect(mentions[0].domain).toBe('mastodon.social')
    })

    it('extracts multiple mentions', () => {
      const mentions = extractMentions('@alice and @bob@remote.host')
      expect(mentions).toHaveLength(2)
    })

    it('returns empty array for text without mentions', () => {
      expect(extractMentions('no mentions here')).toHaveLength(0)
    })

    it('captures correct start and end indices', () => {
      const mentions = extractMentions('Hi @test!')
      expect(mentions[0].startIndex).toBe(3)
      expect(mentions[0].endIndex).toBe(8)
    })

    it('handles mentions with underscores and numbers', () => {
      const mentions = extractMentions('@user_name_123')
      expect(mentions[0].username).toBe('user_name_123')
    })
  })

  describe('parseBioWithEmojis', () => {
    it('returns text part when no emojis', () => {
      const result = parseBioWithEmojis('Just a bio', [])
      expect(result).toEqual([{ type: 'text', text: 'Just a bio' }])
    })

    it('returns text part for empty bio', () => {
      const result = parseBioWithEmojis('', [])
      expect(result).toEqual([{ type: 'text', text: '' }])
    })

    it('replaces emoji shortcodes with emoji parts', () => {
      const emojis = [{ name: 'heart', url: 'https://cdn.example.com/heart.png' }]
      const result = parseBioWithEmojis('I :heart: Harmony', emojis)

      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({ type: 'text', text: 'I ' })
      expect(result[1].type).toBe('emoji')
      expect(result[1].emoji.name).toBe('heart')
      expect(result[1].emoji.url).toBe('https://cdn.example.com/heart.png')
      expect(result[2]).toEqual({ type: 'text', text: ' Harmony' })
    })

    it('keeps unrecognized emoji shortcodes as text', () => {
      const emojis = [{ name: 'heart', url: 'https://cdn.example.com/heart.png' }]
      const result = parseBioWithEmojis(':unknown:', emojis)
      expect(result).toEqual([{ type: 'text', text: ':unknown:' }])
    })

    it('handles multiple emojis', () => {
      const emojis = [
        { name: 'a', url: 'https://cdn.example.com/a.png' },
        { name: 'b', url: 'https://cdn.example.com/b.png' },
      ]
      const result = parseBioWithEmojis(':a: and :b:', emojis)
      const emojiParts = result.filter((p: any) => p.type === 'emoji')
      expect(emojiParts).toHaveLength(2)
    })
  })

  describe('generateMentionTags', () => {
    it('generates mention tags for resolved mentions', () => {
      const resolved = [
        {
          mention: { full: '@alice', username: 'alice', startIndex: 0, endIndex: 6 },
          user: { id: '1', username: 'alice', is_local: true } as any,
          actorUrl: 'https://harmony.test/users/alice',
        },
      ]
      const tags = generateMentionTags(resolved)
      expect(tags).toHaveLength(1)
      expect(tags[0].type).toBe('Mention')
      expect(tags[0].href).toBe('https://harmony.test/users/alice')
      expect(tags[0].name).toBe('@alice')
    })

    it('skips mentions without user or actorUrl', () => {
      const resolved = [
        { mention: { full: '@ghost', username: 'ghost', startIndex: 0, endIndex: 6 } },
      ]
      const tags = generateMentionTags(resolved as any)
      expect(tags).toHaveLength(0)
    })
  })

  describe('getDeliveryInboxes', () => {
    it('returns inboxes for remote users only', () => {
      const resolved = [
        {
          mention: { full: '@local', username: 'local', startIndex: 0, endIndex: 6 },
          user: { id: '1', is_local: true } as any,
          inboxUrl: 'https://harmony.test/users/local/inbox',
        },
        {
          mention: { full: '@remote@other.host', username: 'remote', domain: 'other.host', startIndex: 7, endIndex: 25 },
          user: { id: '2', is_local: false } as any,
          inboxUrl: 'https://other.host/users/remote/inbox',
        },
      ]
      const inboxes = getDeliveryInboxes(resolved as any)
      expect(inboxes).toHaveLength(1)
      expect(inboxes[0]).toBe('https://other.host/users/remote/inbox')
    })

    it('deduplicates inbox URLs', () => {
      const resolved = [
        {
          mention: { full: '@a@host', username: 'a', domain: 'host', startIndex: 0, endIndex: 7 },
          user: { id: '1', is_local: false } as any,
          inboxUrl: 'https://host/inbox',
        },
        {
          mention: { full: '@b@host', username: 'b', domain: 'host', startIndex: 8, endIndex: 15 },
          user: { id: '2', is_local: false } as any,
          inboxUrl: 'https://host/inbox',
        },
      ]
      const inboxes = getDeliveryInboxes(resolved as any)
      expect(inboxes).toHaveLength(1)
    })
  })
})
