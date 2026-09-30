import { describe, it, expect } from 'vitest'
import {
  activeTokenAt,
  buildSearchParams,
  dateRangeOf,
  highlightTerms,
  isoMicroBefore,
  isTokenComplete,
  messageMatchesParams,
  parseSearchDate,
  parseSearchQuery,
  resolveToken,
  serializeQuery,
  serializeToken,
  suggestChannels,
  suggestMembers,
  type ParsedQuery,
} from '@/utils/searchQuery'
import type { Message } from '@/types'

const NOW = new Date(2026, 8, 30, 15, 0, 0)
const SERVER = { serverId: 's1' }

describe('parseSearchQuery', () => {
  it('splits filters from free text', () => {
    expect(parseSearchQuery('deploy from:@alice has:image in:#general broken build')).toEqual({
      text: 'deploy broken build',
      tokens: [
        { key: 'from', value: 'alice' },
        { key: 'has', value: 'image' },
        { key: 'in', value: 'general' },
      ],
    })
  })

  it('reads quoted values and lowercases keys and enum values', () => {
    expect(parseSearchQuery('FROM:"Ada Lovelace" HAS:Video pinned:TRUE').tokens).toEqual([
      { key: 'from', value: 'Ada Lovelace' },
      { key: 'has', value: 'video' },
      { key: 'pinned', value: 'true' },
    ])
  })

  it('leaves unknown keys, empty values, phrases and exclusions in the text', () => {
    expect(parseSearchQuery('http://x.io note: foo:bar "exact phrase" -noise from:')).toEqual({
      text: 'http://x.io note: foo:bar "exact phrase" -noise from:',
      tokens: [],
    })
  })

  it('round-trips through serializeQuery', () => {
    const q = 'from:@alice mentions:"@Bob Smith" during:2026-09 hello'
    expect(serializeQuery(parseSearchQuery(q))).toBe(q)
    expect(serializeToken({ key: 'in', value: 'dev chat' })).toBe('in:"#dev chat"')
  })
})

describe('highlightTerms', () => {
  it('keeps plain words for the jump highlight', () => {
    expect(highlightTerms('"bug fix" -noise deploy or ship')).toBe('bug fix deploy ship')
  })
})

describe('activeTokenAt', () => {
  it('reports a partial key', () => {
    expect(activeTokenAt('hello fr', 8)).toEqual({ partial: 'fr', start: 6, end: 8 })
  })

  it('reports a key with its partial value', () => {
    expect(activeTokenAt('x from:@al y', 10)).toEqual({ key: 'from', partial: 'al', start: 2, end: 10 })
    expect(activeTokenAt('in:#gen', 7)).toEqual({ key: 'in', partial: 'gen', start: 0, end: 7 })
  })

  it('follows an unterminated quote across spaces', () => {
    expect(activeTokenAt('from:"Ada Lo', 12)).toEqual({ key: 'from', partial: 'Ada Lo', start: 0, end: 12 })
  })
})

describe('dates', () => {
  it('parses days, months, years and relative days in local time', () => {
    expect(parseSearchDate('2026-02-28', NOW)).toEqual({ start: new Date(2026, 1, 28), end: new Date(2026, 2, 1) })
    expect(parseSearchDate('2026-02', NOW)).toEqual({ start: new Date(2026, 1, 1), end: new Date(2026, 2, 1) })
    expect(parseSearchDate('2025', NOW)).toEqual({ start: new Date(2025, 0, 1), end: new Date(2026, 0, 1) })
    expect(parseSearchDate('yesterday', NOW)).toEqual({ start: new Date(2026, 8, 29), end: new Date(2026, 8, 30) })
  })

  it('rejects impossible and malformed dates', () => {
    expect(parseSearchDate('2026-02-30', NOW)).toBeNull()
    expect(parseSearchDate('2026-13', NOW)).toBeNull()
    expect(parseSearchDate('last week', NOW)).toBeNull()
  })

  it('before and after exclude their day; during covers it; tokens intersect', () => {
    const range = dateRangeOf([
      { key: 'after', value: '2026-09-01' },
      { key: 'before', value: '2026-09-10' },
      { key: 'during', value: '2026-09' },
    ], NOW)
    expect(range).toEqual({ from: new Date(2026, 8, 2), to: new Date(2026, 8, 10), empty: false })
    expect(dateRangeOf([
      { key: 'after', value: '2026-09-10' },
      { key: 'before', value: '2026-09-10' },
    ], NOW).empty).toBe(true)
  })

  it('isoMicroBefore lands one microsecond under the bound', () => {
    expect(isoMicroBefore(new Date('2026-09-10T00:00:00.000Z'))).toBe('2026-09-09T23:59:59.999999Z')
  })
})

describe('buildSearchParams', () => {
  const resolved: ParsedQuery = {
    text: 'deploy',
    tokens: [
      { key: 'from', value: 'alice', id: 'u1' },
      { key: 'from', value: 'bob', id: 'u2' },
      { key: 'mentions', value: 'carol', id: 'u3' },
      { key: 'in', value: 'general', id: 'c1' },
      { key: 'has', value: 'image' },
      { key: 'has', value: 'link' },
      { key: 'pinned', value: 'true' },
      { key: 'during', value: '2026-09-15' },
    ],
  }

  it('maps every filter onto its parameter', () => {
    const p = buildSearchParams(resolved, SERVER, { sort: 'oldest', page: 2, now: NOW })!
    expect(p).toMatchObject({
      p_query: 'deploy',
      p_server_id: 's1',
      p_conversation_id: null,
      p_channel_ids: ['c1'],
      p_user_ids: ['u1', 'u2'],
      p_mentioned_user_ids: ['u3'],
      p_has_image: true,
      p_has_url: true,
      p_has_video: null,
      p_pinned: true,
      p_from_date: new Date(2026, 8, 15).toISOString(),
      p_to_date: isoMicroBefore(new Date(2026, 8, 16)),
      p_sort: 'oldest',
      p_limit: 25,
      p_offset: 50,
      p_with_total: true,
    })
  })

  it('drops unresolved and malformed tokens', () => {
    const p = buildSearchParams({
      text: '',
      tokens: [
        { key: 'from', value: 'nobody' },
        { key: 'has', value: 'poll' },
        { key: 'before', value: 'soon' },
        { key: 'has', value: 'file' },
      ],
    }, SERVER, { now: NOW })!
    expect(p.p_user_ids).toBeNull()
    expect(p.p_to_date).toBeNull()
    expect(p.p_has_media).toBe(true)
    expect(isTokenComplete({ key: 'from', value: 'nobody' })).toBe(false)
  })

  it('ignores in: inside a conversation and scopes to it', () => {
    const p = buildSearchParams(resolved, { serverId: 's1', conversationId: 'd1' }, { now: NOW })!
    expect(p.p_conversation_id).toBe('d1')
    expect(p.p_server_id).toBeNull()
    expect(p.p_channel_ids).toBeNull()
  })

  it('falls back to newest when relevance has no text to rank', () => {
    const p = buildSearchParams({ text: '', tokens: [{ key: 'has', value: 'video' }] }, SERVER, { sort: 'relevance' })!
    expect(p.p_sort).toBe('newest')
  })

  it('returns null for an empty query or disjoint dates', () => {
    expect(buildSearchParams({ text: '  ', tokens: [] }, SERVER)).toBeNull()
    expect(buildSearchParams({ text: 'x', tokens: [
      { key: 'before', value: '2026-01-01' }, { key: 'after', value: '2026-02-01' },
    ] }, SERVER, { now: NOW })).toBeNull()
  })
})

describe('entities', () => {
  const members = [
    { id: 'u1', username: 'alice', displayName: 'Alice :sparkle:' },
    { id: 'u2', username: 'malice', displayName: 'Mal' },
    { id: 'u3', username: 'bob', displayName: 'Alice' },
  ]
  const channels = [{ id: 'c1', name: 'general' }, { id: 'c2', name: 'dev-general' }]

  it('ranks exact, then prefix, then substring matches', () => {
    expect(suggestMembers(members, 'alice').map(m => m.id)).toEqual(['u1', 'u3', 'u2'])
    expect(suggestMembers(members, 'mal').map(m => m.id)).toEqual(['u2'])
    expect(suggestChannels(channels, 'gen').map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('resolves a typed value by username before display name', () => {
    expect(resolveToken({ key: 'from', value: 'Alice' }, { members, channels })).toEqual({ key: 'from', value: 'alice', id: 'u1' })
    expect(resolveToken({ key: 'mentions', value: 'mal' }, { members, channels })).toEqual({ key: 'mentions', value: 'malice', id: 'u2' })
    expect(resolveToken({ key: 'in', value: 'General' }, { members, channels })).toEqual({ key: 'in', value: 'general', id: 'c1' })
    expect(resolveToken({ key: 'from', value: 'nobody' }, { members, channels }).id).toBeUndefined()
  })
})

describe('messageMatchesParams', () => {
  const msg = (over: Partial<Message>): Message => ({
    id: 'm', created_at: new Date(2026, 8, 15, 12), content: [{ type: 'text', text: 'hi' }], ...over,
  } as Message)
  const base = buildSearchParams({ text: 'x', tokens: [] }, { conversationId: 'd1' }, { now: NOW })!

  it('applies author, mention, has, pinned and date filters', () => {
    const m = msg({
      user_id: 'u1',
      is_pinned: true,
      content: [
        { type: 'mention', userId: 'u3', username: 'carol', domain: 'x', isLocal: true },
        { type: 'file', url: 'a.ogg', fileType: 'audio/ogg' },
      ],
    })
    expect(messageMatchesParams(m, { ...base, p_user_ids: ['u1'], p_mentioned_user_ids: ['u3'], p_has_audio: true, p_pinned: true })).toBe(true)
    expect(messageMatchesParams(m, { ...base, p_user_ids: ['u2'] })).toBe(false)
    expect(messageMatchesParams(m, { ...base, p_has_image: true })).toBe(false)
    expect(messageMatchesParams(m, { ...base, p_pinned: false })).toBe(false)
    expect(messageMatchesParams(m, { ...base, p_from_date: new Date(2026, 8, 16).toISOString() })).toBe(false)
  })

  it('counts link previews in metadata as embeds', () => {
    const m = msg({ metadata: { embeds: { 'https://a': {} as never } } })
    expect(messageMatchesParams(m, { ...base, p_has_embed: true })).toBe(true)
  })
})
