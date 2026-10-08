/**
 * Search index ranking and shortcode aliases against the bundled unicode set
 * (public/assets/emojis/unicode-emoji-data.json) plus the Discord alias map.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/services/emojiIndexedDBCache', () => ({
  getCachedStaticEmojiData: vi.fn(async () => null),
  setCachedStaticEmojiData: vi.fn(async () => {}),
  getAllCachedServerEmojis: vi.fn(async () => []),
  setCachedServerEmojis: vi.fn(async () => {}),
  removeCachedServerEmojis: vi.fn(async () => {}),
  getCachedServerEmojis: vi.fn(async () => null),
}))
vi.mock('@/services/userDataService', () => ({ userDataService: { reResolveAllDisplayNames: () => {} } }))

import {
  loadEmojiData,
  searchEmojiHits,
  shortcodeToUnicode,
} from '@/services/unifiedEmojiService'
import { customEmojiIndex, searchCustomIndex, customMatches } from '@/services/emojiSearchIndex'
import type { ResolvedEmoji } from '@/types'

let realFetch: typeof fetch

beforeAll(async () => {
  const json = readFileSync(resolve(__dirname, '../../../public/assets/emojis/unicode-emoji-data.json'), 'utf8')
  realFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string) =>
    String(url).includes('unicode-emoji-data.json') ? new Response(json) : new Response('{}'),
  ) as unknown as typeof fetch
  await loadEmojiData()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const top = (q: string) => searchEmojiHits(q, 10)[0]

describe('unicode search ranking', () => {
  it('`joy` ranks 😂 first, as `:joy:`', () => {
    const hit = top('joy')
    expect(hit.item.emoji.unicode).toBe('😂')
    expect(hit.tier).toBe(0)
    expect(hit.matched).toBe('joy')
  })

  it('a prefix of an alias ranks the alias first: `jo` -> 😂', () => {
    expect(top('jo').item.emoji.unicode).toBe('😂')
  })

  it.each([
    ['thumbsup', '👍'],
    ['+1', '👍'],
    ['thumbup', '👍'],
    ['-1', '👎'],
    ['heart', '❤️'],
    ['smile', '😄'],
    ['sob', '😭'],
    ['fire', '🔥'],
    ['100', '💯'],
    ['pray', '🙏'],
    ['eyes', '👀'],
    ['skull', '💀'],
    ['slight_smile', '🙂'],
    ['upside_down', '🙃'],
    ['thinking', '🤔'],
    ['flag_us', '🇺🇸'],
  ])('exact alias `%s` -> %s first', (q, unicode) => {
    const hit = top(q)
    expect(hit.item.emoji.unicode).toBe(unicode)
    expect(hit.tier).toBe(0)
  })

  it('orders exact, then prefix, then word, then substring', () => {
    const hits = searchEmojiHits('cat', 50)
    const tiers = hits.map(h => h.tier)
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers)
    expect(hits[0].item.emoji.unicode).toBe('🐈')
    expect(tiers).toContain(1)
  })

  it('matches keywords and name words below aliases', () => {
    const hit = searchEmojiHits('tears', 50).find(h => h.item.emoji.unicode === '😂')
    expect(hit?.tier).toBe(2)
  })

  it('matches substrings at the lowest tier', () => {
    const hits = searchEmojiHits('ughing', 50)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.tier === 3)).toBe(true)
  })

  it('returns nothing for an empty or unknown query', () => {
    expect(searchEmojiHits('', 10)).toEqual([])
    expect(searchEmojiHits('zzzzqqq', 10)).toEqual([])
  })
})

describe('shortcode alias resolution', () => {
  it.each([
    ['joy', '😂'],
    ['thumbsup', '👍'],
    ['+1', '👍'],
    ['heart', '❤️'],
    ['slight_smile', '🙂'],
    ['slight_frown', '🙁'],
    ['flag_gb', '🇬🇧'],
    ['regional_indicator_a', '🇦'],
    ['face_with_tears_of_joy', '😂'],
  ])('`%s` -> %s', (code, unicode) => {
    expect(shortcodeToUnicode(code)).toBe(unicode)
  })
})

describe('custom emoji index', () => {
  const mk = (id: string, name: string, display = name): ResolvedEmoji => ({ id, name, display_name: display, url: `https://e/${id}.png` })
  const resolved = {
    'srv-a': { server_name: 'Alpha', emojis: [mk('1', 'partyblob'), mk('2', 'joy'), mk('3', 'blob_joy')] },
    'srv-b': { server_name: 'Beta', emojis: [mk('4', 'joyful'), mk('5', 'joy', 'joy~1')] },
  }

  it('lists the current server first and caches per resolved object', () => {
    const a = customEmojiIndex(resolved, 'srv-b')
    expect(a[0].serverName).toBe('Beta')
    expect(customEmojiIndex(resolved, 'srv-b')).toBe(a)
    expect(customEmojiIndex(resolved, 'srv-a')[0].serverName).toBe('Alpha')
  })

  it('ranks exact, prefix, segment, substring', () => {
    const hits = searchCustomIndex(customEmojiIndex(resolved, 'srv-a'), 'joy')
    expect(hits.map(h => [h.item.emoji.id, h.tier])).toEqual([
      ['2', 0],
      ['5', 0],
      ['4', 1],
      ['3', 2],
    ])
  })

  it('returns everything for an empty query, up to the limit', () => {
    const entries = customEmojiIndex(resolved, null)
    expect(searchCustomIndex(entries, '').length).toBe(5)
    expect(searchCustomIndex(entries, '', 2).length).toBe(2)
  })

  it('customMatches mirrors search', () => {
    const [first] = customEmojiIndex(resolved, 'srv-a')
    expect(customMatches(first, 'BLOB')).toBe(true)
    expect(customMatches(first, 'nope')).toBe(false)
  })
})
