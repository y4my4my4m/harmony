import { describe, expect, it } from 'vitest'
import {
  PREFIX_MAX,
  indexTerms,
  matchesQuery,
  normalizeSearchText,
  parseIndexQuery,
  searchableText,
  textRuns,
} from '@/utils/searchTokens'
import type { MessagePart } from '@/types'

/** Candidate test as the index runs it: every lookup term of some alternative is indexed. */
function candidate(query: string, text: string): boolean {
  const terms = indexTerms(text)
  return parseIndexQuery(query).alternatives.some(alt => alt.terms.every(t => t.lookup.every(l => terms.has(l))))
}

/** Index lookup and the match on the decrypted text, as the search runs them. */
function finds(query: string, text: string): boolean {
  return candidate(query, text) && matchesQuery(parseIndexQuery(query), text)
}

describe('normalizeSearchText', () => {
  it('folds width, case and Latin diacritics', () => {
    expect(normalizeSearchText('ＨＥＬＬＯ Café Ñandú')).toBe('hello cafe nandu')
  })

  it('keeps kana voicing marks and turns half-width katakana full width', () => {
    expect(normalizeSearchText('が')).toBe('が')
    expect(normalizeSearchText('ｶﾞｷﾞ')).toBe('ガギ')
    expect(normalizeSearchText('が')).not.toBe(normalizeSearchText('か'))
  })
})

describe('textRuns', () => {
  it('splits CJK runs from words', () => {
    expect(textRuns(normalizeSearchText('東京タワーに行った2024 trip'))).toEqual([
      { text: '東京タワーに行った', cjk: true },
      { text: '2024', cjk: false },
      { text: 'trip', cjk: false },
    ])
  })
})

describe('indexTerms', () => {
  it('indexes word prefixes from two characters', () => {
    expect([...indexTerms('Hello')]).toEqual(['w:he', 'w:hel', 'w:hell', 'w:hello'])
  })

  it('indexes a one-character word as itself', () => {
    expect([...indexTerms('a')]).toEqual(['w:a'])
  })

  it(`caps prefixes at ${PREFIX_MAX} characters`, () => {
    const word = 'x'.repeat(30)
    const terms = [...indexTerms(word)]
    expect(terms).toHaveLength(PREFIX_MAX - 1)
    expect(terms.at(-1)).toBe(`w:${'x'.repeat(PREFIX_MAX)}`)
  })

  it('indexes CJK unigrams and bigrams', () => {
    expect([...indexTerms('猫が好き')].sort()).toEqual(
      ['c:が', 'c:が好', 'c:好', 'c:好き', 'c:き', 'c:猫', 'c:猫が'].sort(),
    )
  })

  it('holds no whole sentence and no term spanning a word gap', () => {
    const terms = indexTerms('secret plan')
    expect(terms.has('w:secret plan')).toBe(false)
    expect([...terms].some(t => t.includes(' '))).toBe(false)
  })
})

describe('parseIndexQuery', () => {
  it('reads words, quoted phrases, exclusions and or', () => {
    const q = parseIndexQuery('pizza "red sauce" -olive or 寿司')
    expect(q.alternatives).toHaveLength(2)
    expect(q.alternatives[0].terms.map(t => [t.kind, t.value])).toEqual([['word', 'pizza'], ['phrase', 'red sauce']])
    expect(q.alternatives[0].exclude.map(t => t.value)).toEqual(['olive'])
    expect(q.alternatives[1].terms.map(t => [t.kind, t.value, t.lookup])).toEqual([['cjk', '寿司', ['c:寿司']]])
  })

  it('has no alternative without letters', () => {
    expect(parseIndexQuery('!!! ...').alternatives).toEqual([])
  })
})

describe('finding messages', () => {
  it('matches a word prefix', () => {
    expect(finds('pizz', 'Who wants pizza tonight?')).toBe(true)
  })

  it('does not match inside a word (negative control)', () => {
    expect(finds('izza', 'Who wants pizza tonight?')).toBe(false)
  })

  it('needs every word', () => {
    expect(finds('pizza beer', 'pizza tonight')).toBe(false)
    expect(finds('pizza tonight', 'Tonight: PIZZA!')).toBe(true)
  })

  it('matches across width, case and accents', () => {
    expect(finds('cafe', 'Meet at the CAFÉ')).toBe(true)
    expect(finds('ｃａｆｅ', 'meet at the cafe')).toBe(true)
  })

  it('matches Japanese inside a sentence without spaces', () => {
    const text = '来週の金曜日に東京タワーへ行きましょう'
    expect(finds('東京タワー', text)).toBe(true)
    expect(finds('タワー', text)).toBe(true)
    expect(finds('金曜', text)).toBe(true)
    expect(finds('京', text)).toBe(true)
  })

  it('rejects Japanese whose characters are present but not adjacent (negative control)', () => {
    const text = '東の京都タワー'
    // Unigrams 東 京 are there; the bigram 東京 is not.
    expect(candidate('東京', text)).toBe(false)
    expect(finds('東京', text)).toBe(false)
  })

  it('verifies a CJK run longer than two characters on the text', () => {
    // Bigrams 東京 京タ タワ all present, but not as one run.
    const text = '東京 京タ タワ'
    expect(candidate('東京タワ', text)).toBe(true)
    expect(finds('東京タワ', text)).toBe(false)
  })

  it('matches Korean and Chinese', () => {
    expect(finds('안녕', '안녕하세요 여러분')).toBe(true)
    expect(finds('北京', '我明天去北京开会')).toBe(true)
    expect(finds('上海', '我明天去北京开会')).toBe(false)
  })

  it('matches half-width katakana queries against full-width text', () => {
    expect(finds('ｶﾀｶﾅ', 'カタカナで書く')).toBe(true)
  })

  it('applies phrases and exclusions', () => {
    expect(finds('"red sauce"', 'pasta with red sauce')).toBe(true)
    expect(finds('"red sauce"', 'red pasta, white sauce')).toBe(false)
    expect(finds('pasta -white', 'red pasta, white sauce')).toBe(false)
    expect(finds('pasta -white', 'red pasta')).toBe(true)
  })

  it('matches any alternative of or', () => {
    expect(finds('sushi or ramen', 'ramen at noon')).toBe(true)
    expect(finds('sushi or ramen', 'pizza at noon')).toBe(false)
  })

  it('matches a long word by its first letters', () => {
    const text = 'internationalization matters'
    expect(finds('internationalizat', text)).toBe(true)
    expect(finds('internationalizer', text)).toBe(false)
  })

  it('matches a one-letter word as a whole word only', () => {
    expect(finds('a', 'a plan')).toBe(true)
    expect(finds('a', 'apple plan')).toBe(false)
  })
})

describe('searchableText', () => {
  it('reads text, mentions, link labels, files, stickers and polls', () => {
    const parts = [
      { type: 'text', text: 'see' },
      { type: 'mention', userId: 'u', username: 'alice', domain: 'x', isLocal: true, displayName: 'Alice A' },
      { type: 'url', url: 'https://example.com/doc', preview: false, label: 'the doc' },
      { type: 'file', url: 'u', fileType: 'application/pdf', fileName: 'report.pdf' },
      { type: 'sticker', id: 's', url: 'u', name: 'wave', description: 'waving cat' },
      { type: 'poll', pollId: 'p', question: 'Lunch?', options: ['sushi', 'ramen'] },
    ] as MessagePart[]
    const text = searchableText(parts)
    for (const word of ['see', 'alice', 'the doc', 'example.com', 'report.pdf', 'waving cat', 'Lunch?', 'ramen']) {
      expect(text).toContain(word)
    }
  })
})
