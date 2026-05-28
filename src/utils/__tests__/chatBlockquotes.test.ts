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
    it('matches lines starting with `> ` followed by content', () => {
      expect(isSingleQuoteLine('> hello')).toBe(true)
    })

    it('does NOT match a bare `>` (incomplete marker, user still typing)', () => {
      // Promoting a lone `>` to a blockquote rewrites the editor's DOM
      // into a styled scaffold mid-keystroke, stranding the cursor inside
      // a zero-width content span and breaking subsequent typing.
      expect(isSingleQuoteLine('>')).toBe(false)
    })

    it('does NOT match `> ` with no content (also incomplete)', () => {
      // Same problem class as bare `>`: the renderer would emit a
      // blockquote with a zero-width content span, the cursor would
      // land at the end of the styled marker, and the next keystroke
      // would go into the marker (which is read back via the
      // `data-prefix` attribute, ignoring any user edits) — effectively
      // dropping the character.
      expect(isSingleQuoteLine('> ')).toBe(false)
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
    it('matches lines starting with a SINGLE `>` and a non-space character', () => {
      expect(isGreentextLine('>hello')).toBe(true)
      expect(isGreentextLine('>be me')).toBe(true)
    })

    it('does NOT match `> foo` (blockquote)', () => {
      expect(isGreentextLine('> hello')).toBe(false)
    })

    it('does NOT match `>>foo` (double `>` — imageboard reply syntax, not greentext)', () => {
      expect(isGreentextLine('>>hello')).toBe(false)
      expect(isGreentextLine('>>12345')).toBe(false)
    })

    it('does NOT match `>>>foo` (triple `>` — partially-typed multi-line blockquote)', () => {
      // Promoting `>>>foo` to greentext caused a green flash while the
      // user was typing `>>>` + ` ` + content toward a multi-line
      // blockquote. Multiple `>`s are deliberately not greentext.
      expect(isGreentextLine('>>>hello')).toBe(false)
    })

    it('does NOT match `>>> hello` (multi-quote blockquote start)', () => {
      expect(isGreentextLine('>>> hello')).toBe(false)
    })

    it('does NOT match a bare `>` (incomplete marker)', () => {
      expect(isGreentextLine('>')).toBe(false)
    })

    it('does NOT match a bare `>>>` (incomplete multi-quote marker)', () => {
      expect(isGreentextLine('>>>')).toBe(false)
    })

    it('does NOT match a line that does not START with `>`', () => {
      // The `>` after the URL is not at column 0, so the line as a whole
      // is plain text. (Discord-style URLs wrapped in `<…>` are a common
      // way users sneak a `>` into the middle of a message.)
      expect(isGreentextLine('<https://example.com>check this out')).toBe(false)
      expect(isGreentextLine('hello >world')).toBe(false)
    })
  })

  describe('stripSingleQuotePrefix', () => {
    it('removes the `> ` prefix', () => {
      expect(stripSingleQuotePrefix('> hello')).toBe('hello')
    })

    it('leaves a bare `>` alone (not a quote — see isSingleQuoteLine)', () => {
      expect(stripSingleQuotePrefix('>')).toBe('>')
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

    it('treats a lone `>` as plain text — even with greentext enabled', () => {
      // Regression: the editor used to promote `>` to a blockquote the
      // moment the user typed it, which rewrote the DOM mid-keystroke and
      // stranded the cursor inside a styled zero-width content span,
      // making the editor unusable until the user pressed Backspace.
      expect(splitIntoBlockSegments('>', { greentext: true })).toEqual([
        { type: 'text', content: '>' },
      ])
    })

    it('treats `> ` (trailing space, no content) as plain text', () => {
      // Same problem class as a bare `>`. The blockquote scaffold's
      // `data-prefix` is the source of truth for the prefix in
      // `getPlainText`, so any chars typed into the styled marker span
      // would be dropped on the next render cycle.
      expect(splitIntoBlockSegments('> ', { greentext: true })).toEqual([
        { type: 'text', content: '> ' },
      ])
    })

    it('treats a lone `>>>` as plain text — even with greentext enabled', () => {
      expect(splitIntoBlockSegments('>>>', { greentext: true })).toEqual([
        { type: 'text', content: '>>>' },
      ])
    })

    it('treats `>>> ` (trailing space, no content) as plain text', () => {
      expect(splitIntoBlockSegments('>>> ', { greentext: true })).toEqual([
        { type: 'text', content: '>>> ' },
      ])
    })

    it('promotes `>` to a blockquote only once the user adds a space + content', () => {
      // The space-after-`>` plus at least one content character is the
      // user's commit signal that they meant a quote. Matches Discord's
      // behaviour and — combined with the incomplete-marker rules above
      // — avoids the editor-cursor-trap that prompted the fix.
      expect(splitIntoBlockSegments('> hi', { greentext: true })).toEqual([
        { type: 'blockquote', lines: ['hi'] },
      ])
    })

    it('promotes `>>>` to a multi-line blockquote only once content follows', () => {
      expect(splitIntoBlockSegments('>>> hello\nworld', { greentext: true })).toEqual([
        { type: 'blockquote', lines: ['hello', 'world'], multiLine: true },
      ])
    })

    it('treats `>>foo` as plain text (NOT greentext)', () => {
      // Double-`>` is the imageboard quote-reply syntax; users don't
      // expect it to render as greentext.
      expect(splitIntoBlockSegments('>>foo', { greentext: true })).toEqual([
        { type: 'text', content: '>>foo' },
      ])
    })

    it('treats `>>>foo` as plain text (NOT greentext)', () => {
      // Triple-`>` is the partially-typed multi-line blockquote marker.
      // Promoting it to greentext caused a green flash mid-keystroke.
      expect(splitIntoBlockSegments('>>>foo', { greentext: true })).toEqual([
        { type: 'text', content: '>>>foo' },
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
