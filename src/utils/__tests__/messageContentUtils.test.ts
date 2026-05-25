import { describe, it, expect } from 'vitest'
import {
  messagePartsToMarkdown,
  messagePartsToPlainText,
  isSingleEmojiMessage,
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
})
