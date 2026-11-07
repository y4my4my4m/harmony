import { describe, it, expect } from 'vitest'
import {
  ilikeContains,
  normalizeDomainQuery,
  postEngagement,
  rankPeopleDomains,
  rankPostDomains,
  sourceSuggestions,
} from '../instanceSourceRanking'

const post = (domain: string, counts: { r?: number; b?: number; f?: number } = {}, isLocal = false) => ({
  author: { domain, is_local: isLocal },
  replies_count: counts.r ?? 0,
  reblogs_count: counts.b ?? 0,
  favorites_count: counts.f ?? 0,
})

describe('postEngagement', () => {
  it('weighs replies, boosts and favourites as get_trending_posts does', () => {
    expect(postEngagement(post('a', { r: 1 }))).toBe(3)
    expect(postEngagement(post('a', { b: 1 }))).toBe(2)
    expect(postEngagement(post('a', { f: 1 }))).toBe(1)
    expect(postEngagement(post('a', { r: 10, b: 10, f: 10 }))).toBeCloseTo(
      Math.pow(10, 0.9) * 3 + Math.pow(10, 0.8) * 2 + Math.pow(10, 0.7),
    )
    expect(postEngagement({ replies_count: -4, reblogs_count: null, favorites_count: undefined })).toBe(0)
  })
})

describe('rankPostDomains', () => {
  it('orders by post count, then engagement, then name', () => {
    const ranked = rankPostDomains([
      post('one.test', { f: 1 }),
      post('busy.test', { f: 1 }),
      post('busy.test', { f: 1 }),
      post('busy.test', { f: 1 }),
      post('loud.test', { f: 500 }),
      post('loud.test', { f: 1 }),
      post('quiet.test', { f: 1 }),
      post('quiet.test', { f: 1 }),
      post('b-tie.test', { r: 1 }),
      post('a-tie.test', { r: 1 }),
    ])
    expect(ranked.map(r => r.domain)).toEqual([
      'busy.test', 'loud.test', 'quiet.test', 'a-tie.test', 'b-tie.test', 'one.test',
    ])
    expect(ranked[0]).toEqual({ domain: 'busy.test', count: 3, kind: 'posts' })
  })

  it('leaves out local authors and the local domain, and folds case', () => {
    const ranked = rankPostDomains([
      post('here.test', { f: 9 }),
      post('Remote.Test', { f: 1 }),
      post('remote.test', { f: 1 }),
      post('elsewhere.test', { f: 9 }, true),
      { author: null, favorites_count: 5 },
    ], 'HERE.test')
    expect(ranked).toEqual([{ domain: 'remote.test', count: 2, kind: 'posts' }])
  })
})

describe('rankPeopleDomains', () => {
  it('orders by accounts, then first appearance', () => {
    const ranked = rankPeopleDomains([
      { domain: 'first.test' },
      { domain: 'two.test' },
      { domain: 'here.test', is_local: true },
      { domain: 'two.test' },
      { domain: 'last.test' },
    ], 'here.test')
    expect(ranked.map(r => [r.domain, r.count])).toEqual([['two.test', 2], ['first.test', 1], ['last.test', 1]])
  })
})

describe('sourceSuggestions', () => {
  const posts = rankPostDomains(['a', 'b', 'c'].map(d => post(`${d}.test`, { f: 1 })))

  it('pins the selection, then post domains, people domains and recent instances, each once', () => {
    const out = sourceSuggestions({
      selected: 'Picked.test',
      posts,
      people: [{ domain: 'b.test', count: 4, kind: 'people' }, { domain: 'p.test', count: 1, kind: 'people' }],
      recent: ['c.test', 'here.test', 'r1.test', 'r2.test', 'r3.test'],
      localDomain: 'here.test',
      limit: 7,
    })
    expect(out.map(s => [s.domain, s.group])).toEqual([
      ['picked.test', 'pinned'],
      ['a.test', 'results'],
      ['b.test', 'results'],
      ['c.test', 'results'],
      ['p.test', 'results'],
      ['r1.test', 'recent'],
      ['r2.test', 'recent'],
    ])
    expect(out[4]).toMatchObject({ count: 1, kind: 'people' })
  })

  it('keeps the count of a pinned domain that also ranks', () => {
    const out = sourceSuggestions({ selected: 'b.test', posts, limit: 8 })
    expect(out.map(s => s.domain)).toEqual(['b.test', 'a.test', 'c.test'])
    expect(out[0]).toEqual({ domain: 'b.test', group: 'pinned', count: 1, kind: 'posts' })
  })

  it('pins nothing for all instances or this instance', () => {
    expect(sourceSuggestions({ selected: '', posts, limit: 8 }).map(s => s.group)).toEqual(['results', 'results', 'results'])
    expect(sourceSuggestions({ selected: 'local', posts, limit: 8 }).map(s => s.group)).toEqual(['results', 'results', 'results'])
  })

  it('caps at the limit', () => {
    const many = rankPostDomains(Array.from({ length: 12 }, (_, i) => post(`d${String(i).padStart(2, '0')}.test`)))
    expect(sourceSuggestions({ posts: many, limit: 8 })).toHaveLength(8)
  })
})

describe('normalizeDomainQuery', () => {
  it('reduces typed text to a domain fragment', () => {
    expect(normalizeDomainQuery('  Mastodon.Social ')).toBe('mastodon.social')
    expect(normalizeDomainQuery('https://example.com/@user/123')).toBe('example.com')
    expect(normalizeDomainQuery('@alice@social.example')).toBe('social.example')
    expect(normalizeDomainQuery('host.test:8443')).toBe('host.test:8443')
    expect(normalizeDomainQuery('ex%am*ple,te)st(')).toBe('exampletest')
    expect(normalizeDomainQuery('日本.jp')).toBe('日本.jp')
    expect(normalizeDomainQuery('%*,()')).toBe('')
  })
})

describe('ilikeContains', () => {
  it('escapes LIKE wildcards', () => {
    expect(ilikeContains('a_b')).toBe('%a\\_b%')
    expect(ilikeContains('50%')).toBe('%50\\%%')
    expect(ilikeContains('back\\slash')).toBe('%back\\\\slash%')
  })
})
