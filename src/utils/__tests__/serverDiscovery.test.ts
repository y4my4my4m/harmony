import { describe, it, expect } from 'vitest'
import {
  buildServerSearchFilter,
  escapeLikePattern,
  inferServerCategory,
  normalizeSearchTerm,
  MAX_SEARCH_TERM_LENGTH,
} from '../serverDiscovery'

describe('inferServerCategory', () => {
  it('matches whole words only', () => {
    expect(inferServerCategory('Main Hall', 'A place to paint')).toBe('Other')
    expect(inferServerCategory('Artemis', null)).toBe('Other')
    expect(inferServerCategory('Showcase', 'Fun times')).toBe('Other')
  })

  it('matches keywords regardless of case and punctuation', () => {
    expect(inferServerCategory('AI Lab')).toBe('Technology')
    expect(inferServerCategory('The Pixel Den', 'Indie games, speedruns & chill')).toBe('Gaming')
    expect(inferServerCategory('Studio', 'digital-art / illustration')).toBe('Art & Design')
  })

  it('uses category order to break ties', () => {
    expect(inferServerCategory('Gaming community')).toBe('Gaming')
    expect(inferServerCategory('Friends of Physics')).toBe('Community')
  })

  it('reads the description when the name has no keyword', () => {
    expect(inferServerCategory('Harmony HQ', 'Weekly football talk')).toBe('Sports')
  })
})

describe('normalizeSearchTerm', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeSearchTerm('  foo \n\t bar  ')).toBe('foo bar')
  })

  it('caps length', () => {
    expect(normalizeSearchTerm('x'.repeat(500))).toHaveLength(MAX_SEARCH_TERM_LENGTH)
  })
})

describe('escapeLikePattern', () => {
  it('escapes LIKE metacharacters and the escape character', () => {
    expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world')
  })
})

describe('buildServerSearchFilter', () => {
  it('returns null for blank input', () => {
    expect(buildServerSearchFilter('   ')).toBeNull()
  })

  it('quotes the pattern for both columns', () => {
    expect(buildServerSearchFilter('rust')).toBe(
      'name.ilike."%rust%",description.ilike."%rust%"',
    )
  })

  it('keeps PostgREST reserved characters inside quotes', () => {
    const filter = buildServerSearchFilter('a,b.c:(d)')!
    expect(filter).toBe('name.ilike."%a,b.c:(d)%",description.ilike."%a,b.c:(d)%"')
  })

  it('escapes quotes and backslashes for the quoted value', () => {
    // LIKE escape doubles the backslash, quoting doubles it again.
    expect(buildServerSearchFilter('say "hi" \\o/')).toBe(
      'name.ilike."%say \\"hi\\" \\\\\\\\o/%",description.ilike."%say \\"hi\\" \\\\\\\\o/%"',
    )
  })

  it('escapes % and _ so they match literally', () => {
    expect(buildServerSearchFilter('50%_')).toBe(
      'name.ilike."%50\\\\%\\\\_%",description.ilike."%50\\\\%\\\\_%"',
    )
  })

  it('maps * to the single-character wildcard', () => {
    expect(buildServerSearchFilter('a*b')).toBe('name.ilike."%a_b%",description.ilike."%a_b%"')
  })
})
