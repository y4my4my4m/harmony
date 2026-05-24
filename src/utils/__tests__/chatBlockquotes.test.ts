import { describe, it, expect } from 'vitest'
import {
  splitIntoBlockSegments,
  renderTextWithBlockquotes,
  isSingleQuoteLine,
  stripSingleQuotePrefix,
} from '@/utils/chatBlockquotes'

describe('chatBlockquotes', () => {
  describe('isSingleQuoteLine', () => {
    it('matches lines starting with >', () => {
      expect(isSingleQuoteLine('> hello')).toBe(true)
      expect(isSingleQuoteLine('>hello')).toBe(true)
      expect(isSingleQuoteLine('>')).toBe(true)
    })

    it('does not match regular lines', () => {
      expect(isSingleQuoteLine('hello > world')).toBe(false)
      expect(isSingleQuoteLine('>>> hello')).toBe(false)
    })
  })

  describe('stripSingleQuotePrefix', () => {
    it('removes the leading marker', () => {
      expect(stripSingleQuotePrefix('> hello')).toBe('hello')
      expect(stripSingleQuotePrefix('>hello')).toBe('hello')
      expect(stripSingleQuotePrefix('>')).toBe('')
    })
  })

  describe('splitIntoBlockSegments', () => {
    it('groups consecutive single-line quotes', () => {
      expect(splitIntoBlockSegments('> one\n> two')).toEqual([
        { type: 'blockquote', lines: ['one', 'two'] },
      ])
    })

    it('splits blockquotes on blank lines', () => {
      expect(splitIntoBlockSegments('> one\n\n> two')).toEqual([
        { type: 'blockquote', lines: ['one'] },
        { type: 'text', content: '' },
        { type: 'blockquote', lines: ['two'] },
      ])
    })

    it('handles >>> multi-line blockquotes', () => {
      expect(splitIntoBlockSegments('>>> hello\nworld')).toEqual([
        { type: 'blockquote', lines: ['hello', 'world'], multiLine: true },
      ])
    })

    it('keeps regular text separate', () => {
      expect(splitIntoBlockSegments('before\n> quote\nafter')).toEqual([
        { type: 'text', content: 'before' },
        { type: 'blockquote', lines: ['quote'] },
        { type: 'text', content: 'after' },
      ])
    })

    it('does not treat `>` lines inside fenced code blocks as quotes', () => {
      expect(splitIntoBlockSegments('```\n> ls\n```')).toEqual([
        { type: 'text', content: '```\n> ls\n```' },
      ])
    })
  })

  describe('renderTextWithBlockquotes', () => {
    it('wraps quoted lines in blockquote markup', () => {
      const html = renderTextWithBlockquotes('> hello')
      expect(html).toBe('<blockquote class="md-blockquote">hello</blockquote>')
    })

    it('preserves regular lines outside quotes', () => {
      const html = renderTextWithBlockquotes('line one\n> quoted')
      expect(html).toBe('line one<br><blockquote class="md-blockquote">quoted</blockquote>')
    })

    it('applies the line renderer inside quotes', () => {
      const html = renderTextWithBlockquotes('> **bold**', (line) => `<strong>${line}</strong>`)
      expect(html).toBe('<blockquote class="md-blockquote"><strong>**bold**</strong></blockquote>')
    })
  })
})
