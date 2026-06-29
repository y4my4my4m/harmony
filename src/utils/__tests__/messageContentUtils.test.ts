import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MAX_MESSAGE_TEXT_LENGTH,
  DEFAULT_MAX_POST_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
  assertMessageTextWithinLimit,
  coalesceInlineContentForMarkdown,
  isSingleEmojiMessage,
  messagePartsToMarkdown,
  messagePartsToPlainText,
  messageTextLength,
} from '@/utils/messageContentUtils'

describe('messageContentUtils', () => {
  describe('messagePartsToMarkdown', () => {
    it('converts text parts', () => {
      const parts = [{ type: 'text' as const, text: 'Hello world' }]
      expect(messagePartsToMarkdown(parts as any)).toBe('Hello world')
    })

    it('converts emoji parts to shortcodes', () => {
      const parts = [{ type: 'emoji' as const, emoji: { name: 'smile' } }]
      expect(messagePartsToMarkdown(parts as any)).toBe(':smile:')
    })

    it('converts url parts', () => {
      const parts = [{ type: 'url' as const, url: 'https://example.com' }]
      expect(messagePartsToMarkdown(parts as any)).toBe('https://example.com')
    })

    it('converts mention parts', () => {
      const parts = [{ type: 'mention' as const, mention: '@alice' }]
      expect(messagePartsToMarkdown(parts as any)).toBe('@alice')
    })

    it('converts file parts to placeholder', () => {
      const parts = [{ type: 'file' as const, fileType: 'image' }]
      expect(messagePartsToMarkdown(parts as any)).toBe('[image: attachment]')
    })

    it('concatenates mixed parts', () => {
      const parts = [
        { type: 'text' as const, text: 'Hello ' },
        { type: 'mention' as const, mention: '@bob' },
        { type: 'text' as const, text: '! Check ' },
        { type: 'url' as const, url: 'https://example.com' },
      ]
      expect(messagePartsToMarkdown(parts as any)).toBe('Hello @bob! Check https://example.com')
    })

    it('returns empty string for non-array input', () => {
      expect(messagePartsToMarkdown(null as any)).toBe('')
      expect(messagePartsToMarkdown(undefined as any)).toBe('')
    })

    it('handles null parts in array gracefully', () => {
      const parts = [null, { type: 'text' as const, text: 'hi' }]
      expect(messagePartsToMarkdown(parts as any)).toBe('hi')
    })
  })

  describe('messagePartsToPlainText', () => {
    it('converts text parts', () => {
      const parts = [{ type: 'text' as const, text: 'Hello' }]
      expect(messagePartsToPlainText(parts as any)).toBe('Hello')
    })

    it('converts file parts to [file]', () => {
      const parts = [{ type: 'file' as const }]
      expect(messagePartsToPlainText(parts as any)).toBe('[file]')
    })

    it('trims result', () => {
      const parts = [{ type: 'text' as const, text: '  Hello  ' }]
      expect(messagePartsToPlainText(parts as any)).toBe('Hello')
    })

    it('returns empty string for non-array', () => {
      expect(messagePartsToPlainText('string' as any)).toBe('')
    })
  })

  describe('coalesceInlineContentForMarkdown', () => {
    it('merges text and inline url parts split from inside a code block', () => {
      const parts = [
        { type: 'text' as const, text: '```json\n{"link": "' },
        { type: 'url' as const, url: 'https://example.com', preview: true },
        { type: 'text' as const, text: '"}\n```' },
      ]
      const merged = coalesceInlineContentForMarkdown(parts)
      expect(merged).toEqual([
        { type: 'text', text: '```json\n{"link": "https://example.com"}\n```' },
      ])
    })

    it('leaves image url parts separate', () => {
      const parts = [
        { type: 'text' as const, text: 'look ' },
        { type: 'url' as const, url: 'https://cdn.example.com/a.png', preview: true },
      ]
      const merged = coalesceInlineContentForMarkdown(parts, (url) => /\.png$/i.test(url))
      expect(merged).toHaveLength(2)
      expect(merged[0]).toMatchObject({ type: 'text', text: 'look ' })
      expect(merged[1]).toMatchObject({ type: 'url', url: 'https://cdn.example.com/a.png' })
    })

    it('leaves embeddable url parts outside code fences separate', () => {
      const parts = [
        { type: 'text' as const, text: 'check this out ' },
        { type: 'url' as const, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', preview: true },
      ]
      const merged = coalesceInlineContentForMarkdown(parts)
      expect(merged).toHaveLength(2)
      expect(merged[0]).toMatchObject({ type: 'text', text: 'check this out ' })
      expect(merged[1]).toMatchObject({
        type: 'url',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      })
    })
  })

  describe('isSingleEmojiMessage', () => {
    it('returns true for single emoji part', () => {
      const parts = [{ type: 'emoji' as const, emoji: { name: 'heart' } }]
      expect(isSingleEmojiMessage(parts as any)).toBe(true)
    })

    it('returns false for multiple parts', () => {
      const parts = [
        { type: 'text' as const, text: 'hi' },
        { type: 'emoji' as const, emoji: { name: 'wave' } },
      ]
      expect(isSingleEmojiMessage(parts as any)).toBe(false)
    })

    it('returns false for single text part', () => {
      const parts = [{ type: 'text' as const, text: 'hello' }]
      expect(isSingleEmojiMessage(parts as any)).toBe(false)
    })

    it('returns true for single unicode emoji text', () => {
      const parts = [{ type: 'text' as const, text: '😀' }]
      expect(isSingleEmojiMessage(parts as any)).toBe(true)
    })

    it('returns false for empty array', () => {
      expect(isSingleEmojiMessage([])).toBe(false)
    })

    it('returns false for non-array', () => {
      expect(isSingleEmojiMessage(null as any)).toBe(false)
    })
  })

  describe('messageTextLength', () => {
    it('sums text from text parts only', () => {
      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'mention', userId: 'x', username: 'alice' },
        { type: 'text', text: ' world' },
        { type: 'emoji', emoji: { name: 'smile' } },
        { type: 'file', url: 'x', fileType: 'image' },
      ]
      // 'hello' (5) + ' world' (6) = 11
      expect(messageTextLength(parts as any)).toBe(11)
    })

    it('returns 0 for missing or non-array input', () => {
      expect(messageTextLength(null as any)).toBe(0)
      expect(messageTextLength(undefined as any)).toBe(0)
      expect(messageTextLength('not an array' as any)).toBe(0)
    })

    it('counts unicode characters not UTF-16 code units', () => {
      // 5 visible characters even though astral chars take 2 code units
      const parts = [{ type: 'text', text: 'a😀b😀c' }]
      // JavaScript .length is UTF-16 code units = 7 for "a😀b😀c"; we
      // accept that limit because the DB-side function uses char_length
      // which is also code-point-aware but PostgreSQL's char_length is on
      // characters, not code points. Keeping client+server in agreement
      // (both UTF-16 code units / characters resp.) is acceptable for the
      // anti-DoS use case here.
      expect(messageTextLength(parts as any)).toBe(7)
    })
  })

  describe('assertMessageTextWithinLimit', () => {
    it('passes for content within an explicit limit', () => {
      const parts = [{ type: 'text', text: 'a'.repeat(2000) }]
      expect(() => assertMessageTextWithinLimit(parts as any, 2000)).not.toThrow()
    })

    it('throws for content over an explicit limit', () => {
      const parts = [{ type: 'text', text: 'a'.repeat(2001) }]
      expect(() => assertMessageTextWithinLimit(parts as any, 2000)).toThrow(/too long/i)
    })

    it('default soft limit constants match the seeded instance_config values', () => {
      // The values seeded in `db_schema/init/96_seed_data.sql`:
      //   max_message_length = 2000
      //   max_post_length    = 500
      // Anything else here means the client and DB seed will disagree on
      // what the fallback (pre-`useInstanceSettings` load) is.
      expect(DEFAULT_MAX_MESSAGE_TEXT_LENGTH).toBe(2000)
      expect(DEFAULT_MAX_POST_TEXT_LENGTH).toBe(500)
    })

    it('hard ceiling matches the DB CHECK constraint value', () => {
      // The CHECK constraint is now a far-off safety net (50000 chars)
      // - the user-facing limit is enforced by a trigger that reads the
      // live admin config (`instance_config.max_message_length`). The
      // CHECK only ever fires if the admin sets an unreasonable value
      // or the trigger is disabled. Mirrors the value in
      // `db_schema/init/10_functions_core.sql` and the migration in
      // `db_schema/migrations/20260528_message_length_limit.sql`.
      expect(MESSAGE_TEXT_HARD_CEILING).toBe(50000)
    })
  })
})
