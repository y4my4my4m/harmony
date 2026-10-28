/**
 * get_emoji_source answers parse defensively: anything that is not a well-formed revealed
 * source reads as 'unavailable'. A uuid asks by id with the url it was seen with, and by url
 * when the id answers 'unavailable'; anything else asks by url. Failures read as 'unavailable'
 * and are not kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))

import {
  emojiSourceKey,
  fetchEmojiSource,
  invalidateEmojiSources,
  parseEmojiSource,
} from '@/services/emojiSourceService'

const ID = '11111111-2222-4333-8444-555555555555'

beforeEach(() => {
  rpc.mockReset()
  invalidateEmojiSources()
})

describe('parseEmojiSource', () => {
  it('reads a revealed server', () => {
    expect(parseEmojiSource({
      kind: 'server',
      server: {
        id: 's1', name: 'Plaza', icon: null, public: true, member_count: 3, is_member: false, joinable: true,
        domain: null, emojis: [{ id: 'e2', name: 'b', url: 'https://x/b.png' }, { id: 'bad' }],
      },
    })).toEqual({
      kind: 'server',
      server: {
        id: 's1', name: 'Plaza', icon: null, public: true, memberCount: 3, isMember: false, joinable: true,
        domain: null, emojis: [{ id: 'e2', name: 'b', url: 'https://x/b.png' }],
      },
    })
  })

  it('reads unavailable, and a server without id or name, as unavailable', () => {
    expect(parseEmojiSource({ kind: 'unavailable' })).toEqual({ kind: 'unavailable' })
    expect(parseEmojiSource({ kind: 'server', server: { name: 'x' } })).toEqual({ kind: 'unavailable' })
    expect(parseEmojiSource({ kind: 'server' })).toEqual({ kind: 'unavailable' })
    expect(parseEmojiSource(null)).toEqual({ kind: 'unavailable' })
    expect(parseEmojiSource({ kind: 'surprise' })).toEqual({ kind: 'unavailable' })
    expect(parseEmojiSource({ kind: 'remote' })).toEqual({ kind: 'unavailable' })
  })

  it('reads a personal emoji with and without its owner', () => {
    expect(parseEmojiSource({ kind: 'personal', owner: null })).toEqual({ kind: 'personal', owner: null })
    expect(parseEmojiSource({
      kind: 'personal',
      owner: { id: 'p1', username: 'bob', display_name: 'Bob', avatar_url: null, domain: null, is_local: true },
    })).toEqual({
      kind: 'personal',
      owner: { id: 'p1', username: 'bob', displayName: 'Bob', avatarUrl: null, domain: null, isLocal: true },
    })
  })
})

describe('fetchEmojiSource', () => {
  it('asks by id with the url for a uuid and by url otherwise', async () => {
    rpc.mockResolvedValue({ data: { kind: 'instance' }, error: null })
    await fetchEmojiSource({ id: ID, url: 'https://x/a.png', name: 'a' })
    expect(rpc).toHaveBeenLastCalledWith('get_emoji_source', { p_emoji_id: ID, p_url: 'https://x/a.png' })
    await fetchEmojiSource({ id: 'remote:blob', url: 'https://fedi.example/b.png', name: 'blob' })
    expect(rpc).toHaveBeenLastCalledWith('get_emoji_source_by_url', { p_url: 'https://fedi.example/b.png', p_name: 'blob' })
  })

  it('asks an unavailable id again by its url, as a federated emoji keeps its origin\'s id', async () => {
    rpc.mockResolvedValueOnce({ data: { kind: 'unavailable' }, error: null })
    rpc.mockResolvedValueOnce({ data: { kind: 'remote', domain: 'fedi.example' }, error: null })
    expect(await fetchEmojiSource({ id: ID, url: 'https://fedi.example/b.png', name: 'blob' }))
      .toEqual({ kind: 'remote', domain: 'fedi.example' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_emoji_source', { p_emoji_id: ID, p_url: 'https://fedi.example/b.png' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_emoji_source_by_url', { p_url: 'https://fedi.example/b.png', p_name: 'blob' })
  })

  it('keeps an answer per id and url, and asks again after invalidation', async () => {
    rpc.mockResolvedValue({ data: { kind: 'instance' }, error: null })
    await fetchEmojiSource({ id: ID, url: 'https://x/a.png' })
    await fetchEmojiSource({ id: ID, url: 'https://x/a.png' })
    expect(rpc).toHaveBeenCalledTimes(1)
    await fetchEmojiSource({ id: ID, url: 'https://evil.test/a.png' })
    expect(rpc).toHaveBeenCalledTimes(2)
    invalidateEmojiSources()
    await fetchEmojiSource({ id: ID, url: 'https://x/a.png' })
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('reads a failure as unavailable and does not keep it', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect(await fetchEmojiSource({ id: ID, url: 'https://x/a.png' })).toEqual({ kind: 'unavailable' })
    rpc.mockResolvedValueOnce({ data: { kind: 'instance' }, error: null })
    expect(await fetchEmojiSource({ id: ID, url: 'https://x/a.png' })).toEqual({ kind: 'instance' })
  })

  it('asks nothing without a url', async () => {
    expect(emojiSourceKey({ name: 'x' })).toBeNull()
    expect(emojiSourceKey({ id: ID })).toBeNull()
    expect(await fetchEmojiSource({ name: 'x' })).toEqual({ kind: 'unavailable' })
    expect(await fetchEmojiSource({ id: ID })).toEqual({ kind: 'unavailable' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
