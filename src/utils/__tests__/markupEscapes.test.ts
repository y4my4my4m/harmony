import { describe, expect, it } from 'vitest'
import {
  hideEscapedChars,
  isEscapedAt,
  maskEscapes,
  restoreMasked,
  unescapeMarkup,
} from '@/utils/markupEscapes'

describe('unescapeMarkup', () => {
  it.each([
    ['\\*bold\\*', '*bold*'],
    ['\\_x\\_', '_x_'],
    ['\\~\\~x\\~\\~', '~~x~~'],
    ['\\|\\|s\\|\\|', '||s||'],
    ['\\> quote', '> quote'],
    ['\\@bob', '@bob'],
    ['\\#general', '#general'],
    ['\\:smile:', ':smile:'],
    ['\\[a](https://x.example)', '[a](https://x.example)'],
    ['\\`code\\`', '`code`'],
    ['\\\\', '\\'],
    ['\\https://x.example', 'https://x.example'],
    ['\\HTTP://x.example', 'HTTP://x.example'],
  ])('%j reads as %j', (typed, shown) => {
    expect(unescapeMarkup(typed)).toBe(shown)
  })

  it.each([
    'C:\\Users\\bob',
    'a\\b',
    '\\(x\\)',
    'say \\"hi\\"',
    'trailing\\',
    'no backslash',
    '',
  ])('leaves %j alone', (text) => {
    expect(unescapeMarkup(text)).toBe(text)
  })

  it('keeps inline and fenced code verbatim', () => {
    expect(unescapeMarkup('`\\*`')).toBe('`\\*`')
    expect(unescapeMarkup('```\n\\*\n```')).toBe('```\n\\*\n```')
    expect(unescapeMarkup('`\\` \\*')).toBe('`\\` *')
  })

  it('keeps the shrug whole', () => {
    expect(unescapeMarkup('¯\\_(ツ)_/¯')).toBe('¯\\_(ツ)_/¯')
  })

  it('reads an escaped backslash before a marker as a backslash and a marker', () => {
    expect(unescapeMarkup('\\\\*x')).toBe('\\*x')
  })
})

describe('hideEscapedChars', () => {
  it('keeps every unit, so offsets hold on the original', () => {
    for (const text of ['\\*a\\*', '¯\\_(ツ)_/¯', '\\https://x.example', '`\\*` \\@b']) {
      const hidden = hideEscapedChars(text)
      expect(hidden).toHaveLength(text.length)
      expect(restoreMasked(hidden)).toBe(text)
    }
  })

  it('hides the marker from a parser', () => {
    expect(hideEscapedChars('\\*a\\*')).not.toContain('*')
  })

  it('is idempotent', () => {
    const once = hideEscapedChars('\\*a')
    expect(hideEscapedChars(once)).toBe(once)
  })
})

describe('maskEscapes', () => {
  it('drops the backslash and restores through a renderer', () => {
    const masked = maskEscapes('\\<b\\>')
    expect(masked).not.toContain('<')
    expect(restoreMasked(masked, (ch) => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch))).toBe('&lt;b&gt;')
  })
})

describe('isEscapedAt', () => {
  it('counts the backslash run', () => {
    expect(isEscapedAt('\\@', 1)).toBe(true)
    expect(isEscapedAt('\\\\@', 2)).toBe(false)
    expect(isEscapedAt('\\\\\\@', 3)).toBe(true)
    expect(isEscapedAt('@', 0)).toBe(false)
  })
})
