import { describe, it, expect } from 'vitest'
import {
  splitIntoBlockSegments,
  renderTextWithBlockquotes,
  isSingleQuoteLine,
  isGreentextLine,
  stripSingleQuotePrefix,
} from '@/utils/chatBlockquotes'

describe('chatBlockquotes', () => {
  describe('isSingleQuoteLine', () => {
    it('matches lines starting with `> ` (with space)', () => {
      expect(isSingleQuoteLine('> hello')).toBe(true)
      expect(isSingleQuoteLine('>')).toBe(true)
    })

    it('does NOT match `>foo` without a space', () => {
      expect(isSingleQuoteLine('>hello')).toBe(false)
      expect(isSingleQuoteLine('>direct')).toBe(false)
    })

    it('does not match regular lines or multi-quote start', () => {
      expect(isSingleQuoteLine('hello > world')).toBe(false)
      expect(isSingleQuoteLine('>>> hello')).toBe(false)
    })
  })

  describe('isGreentextLine', () => {
    it('matches lines starting with `>` and a non-space character', () => {
      expect(isGreentextLine('>hello')).toBe(true)
      expect(isGreentextLine('>be me')).toBe(true)
    })

    it('does NOT match `> foo` (blockquote)', () => {
      expect(isGreentextLine('> hello')).toBe(false)
    })

    it('does NOT match `>>>` multi-quote marker', () => {
      expect(isGreentextLine('>>> hello')).toBe(false)
    })

    it('does NOT match plain `>`', () => {
      expect(isGreentextLine('>')).toBe(false)
    })
  })

  describe('stripSingleQuotePrefix', () => {
    it('removes the `> ` prefix', () => {
      expect(stripSingleQuotePrefix('> hello')).toBe('hello')
      expect(stripSingleQuotePrefix('>')).toBe('')
    })
  })

  describe('splitIntoBlockSegments', () => {
    it('groups consecutive `> ` quotes', () => {
      expect(splitIntoBlockSegments('> one\n> two')).toEqual([
        { type: 'blockquote', lines: ['one', 'two'] },
      ])
    })

    it('treats `>foo` as plain text when greentext is disabled', () => {
      expect(splitIntoBlockSegments('>hello')).toEqual([
        { type: 'text', content: '>hello' },
      ])
    })

    it('treats `>foo` as greentext when enabled', () => {
      expect(splitIntoBlockSegments('>hello', { greentext: true })).toEqual([
        { type: 'greentext', lines: ['>hello'] },
      ])
    })

    it('mixes blockquotes and greentext correctly', () => {
      expect(
        splitIntoBlockSegments('> quoted\n>greentext\nnormal', { greentext: true }),
      ).toEqual([
        { type: 'blockquote', lines: ['quoted'] },
        { type: 'greentext', lines: ['>greentext'] },
        { type: 'text', content: 'normal' },
      ])
    })

    it('splits blockquotes on blank lines', () => {
      expect(splitIntoBlockSegments('> one\n\n> two')).toEqual([
        { type: 'blockquote', lines: ['one'] },
        { type: 'text', content: '' },
        { type: 'blockquote', lines: ['two'] },
      ])
    })

    it('handles >>> multi-line blockquotes (requires space)', () => {
      expect(splitIntoBlockSegments('>>> hello\nworld')).toEqual([
        { type: 'blockquote', lines: ['hello', 'world'], multiLine: true },
      ])
    })

    it('does not treat `>` lines inside fenced code blocks as quotes or greentext', () => {
      expect(splitIntoBlockSegments('```\n> ls\n>cat\n```', { greentext: true })).toEqual([
        { type: 'text', content: '```\n> ls\n>cat\n```' },
      ])
    })
  })

  describe('renderTextWithBlockquotes', () => {
    it('wraps quoted lines in blockquote markup', () => {
      const html = renderTextWithBlockquotes('> hello')
      expect(html).toBe('<blockquote class="md-blockquote">hello</blockquote>')
    })

    it('wraps greentext lines in greentext markup when enabled', () => {
      const html = renderTextWithBlockquotes('>be me', (l) => l, { greentext: true })
      expect(html).toBe('<span class="md-greentext">&gt;be me</span>'.replace('&gt;', '>'))
    })

    it('does NOT wrap greentext when option is disabled', () => {
      const html = renderTextWithBlockquotes('>be me', (l) => l)
      expect(html).toBe('>be me')
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
