import { afterEach, describe, expect, it } from 'vitest'
import { findMatches, foldWithMap, highlightSearchMatches, SEARCH_HIGHLIGHT } from '@/utils/searchHighlight'

const marked = (text: string, terms: string[]) => findMatches(text, terms).map(([s, e]) => text.slice(s, e))

describe('findMatches', () => {
  it('folds case and accents on both sides', () => {
    expect(marked('Café crème', ['cafe'])).toEqual(['Café'])
    expect(marked('the cafe', ['CAFÉ'])).toEqual(['cafe'])
  })

  it('maps ß to ss and back to the source letter', () => {
    expect(marked('An der Straße', ['strasse'])).toEqual(['Straße'])
    expect(marked('An der Straße', ['strass'])).toEqual(['Straß'])
  })

  it('matches a latin term at the start of a word only', () => {
    expect(marked('Harmony harmonica', ['harmo'])).toEqual(['Harmo', 'harmo'])
    expect(marked('philharmonic', ['harmo'])).toEqual([])
  })

  it('matches a one-letter latin term as a whole word', () => {
    expect(marked('a cat and a hat', ['a'])).toEqual(['a', 'a'])
  })

  it('matches CJK anywhere', () => {
    expect(marked('東京都庁へ行きます', ['都庁'])).toEqual(['都庁'])
    expect(marked('하모니는 좋아요', ['하모니'])).toEqual(['하모니'])
  })

  it('folds full-width latin and half-width katakana', () => {
    expect(marked('ＡＢＣ ｶﾀｶﾅ', ['abc', 'カタカナ'])).toEqual(['ＡＢＣ', 'ｶﾀｶﾅ'])
  })

  it('composes a half-width voiced mark with its kana', () => {
    expect(marked('ｶﾞｲﾄﾞ', ['ガイド'])).toEqual(['ｶﾞｲﾄﾞ'])
    expect(marked('ｶﾞｲﾄﾞ', ['カイ'])).toEqual([])
  })

  it('keeps source offsets after astral characters', () => {
    const text = '🎉 party 🎉 Party'
    expect(marked(text, ['party'])).toEqual(['party', 'Party'])
  })

  it('merges overlapping matches of several terms', () => {
    expect(findMatches('harmony', ['harm', 'harmony'])).toEqual([[0, 7]])
  })

  it('does not match when the order differs', () => {
    expect(marked('東京都庁', ['京東'])).toEqual([])
  })

  it('maps every folded unit to a source range', () => {
    const { folded, starts, ends } = foldWithMap('Æb')
    expect(folded).toBe('aeb')
    expect(starts).toEqual([0, 0, 1])
    expect(ends).toEqual([1, 1, 2])
  })
})

describe('highlightSearchMatches', () => {
  const g = globalThis as Record<string, unknown>
  const savedCss = g.CSS
  const savedHighlight = g.Highlight

  afterEach(() => {
    g.CSS = savedCss
    g.Highlight = savedHighlight
  })

  it('does nothing without the Custom Highlight API', () => {
    g.CSS = undefined
    const root = document.createElement('div')
    root.textContent = 'harmony'
    expect(() => highlightSearchMatches(root, ['harmony'])()).not.toThrow()
  })

  it('adds ranges over text nodes and removes them', () => {
    const registry = new Map<string, Set<Range>>()
    class FakeHighlight extends Set<Range> {}
    g.Highlight = FakeHighlight
    g.CSS = { highlights: registry }

    const root = document.createElement('div')
    root.innerHTML = '<p>Harmony <b>notes</b> about harmony</p>'
    const clear = highlightSearchMatches(root, ['harmony', 'notes'])
    const set = registry.get(SEARCH_HIGHLIGHT)!
    expect([...set].map(r => r.toString())).toEqual(['Harmony', 'notes', 'harmony'])
    clear()
    expect(set.size).toBe(0)
  })
})
