/**
 * Favourite and boost accounts of a post: one PostgREST read per page, newest
 * first, profiles embedded through the named FK, handles and profile routes as
 * the post header builds them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  result: { data: [] as unknown[] | null, error: null as unknown },
}))

vi.mock('@/supabase', () => {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'range']) {
    builder[method] = (...args: unknown[]) => {
      state.calls.push([method, ...args])
      return builder
    }
  }
  builder.then = (resolve: (value: unknown) => void) => resolve(state.result)
  return {
    supabase: {
      from: (table: string) => {
        state.calls.push(['from', table])
        return builder
      },
    },
  }
})

vi.mock('@/services/runtimeConfig', () => ({ runtimeConfig: { domain: 'harmony.test' } }))

import { fetchInteractionAccounts, toInteractionAccount } from '../postInteractionAccounts'

const profile = (username: string, domain: string, isLocal: boolean | null) => ({
  id: `p-${username}`,
  username,
  display_name: `${username} :blobcat:`,
  avatar_url: `/a/${username}.png`,
  domain,
  is_local: isLocal,
})

beforeEach(() => {
  state.calls = []
  state.result = { data: [], error: null }
})

describe('fetchInteractionAccounts', () => {
  it('reads the post rows of one type, newest first, embedding profiles by FK name', async () => {
    await fetchInteractionAccounts('post-1', 'favorite', 40, 40)
    expect(state.calls).toEqual([
      ['from', 'post_interactions'],
      ['select', expect.stringContaining('profile:profiles!post_interactions_user_id_fkey(')],
      ['eq', 'post_id', 'post-1'],
      ['eq', 'interaction_type', 'favorite'],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['range', 40, 80],
    ])
  })

  it('reports more when the extra row comes back and advances by the rows read', async () => {
    state.result.data = [
      { id: 'i1', profile: profile('alice', 'harmony.test', true) },
      { id: 'i2', profile: null },
      { id: 'i3', profile: profile('bob', 'remote.example', false) },
    ]
    const page = await fetchInteractionAccounts('post-1', 'reblog', 0, 2)
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(2)
    expect(page.accounts.map((a) => a.interactionId)).toEqual(['i1'])

    state.result.data = [{ id: 'i3', profile: profile('bob', 'remote.example', false) }]
    const last = await fetchInteractionAccounts('post-1', 'reblog', 2, 2)
    expect(last.hasMore).toBe(false)
    expect(last.nextOffset).toBe(3)
    expect(last.accounts.map((a) => a.handle)).toEqual(['@bob@remote.example'])
  })

  it('throws the PostgREST error', async () => {
    state.result = { data: null, error: { code: 'PGRST201', message: 'ambiguous' } }
    await expect(fetchInteractionAccounts('post-1', 'favorite')).rejects.toMatchObject({ code: 'PGRST201' })
  })
})

describe('toInteractionAccount', () => {
  it('gives a local account a bare handle and route', () => {
    expect(toInteractionAccount('i1', profile('alice', 'harmony.test', true))).toMatchObject({
      id: 'p-alice',
      displayName: 'alice :blobcat:',
      handle: '@alice',
      routeHandle: 'alice',
    })
  })

  it('qualifies a remote account with its domain', () => {
    expect(toInteractionAccount('i2', profile('bob', 'remote.example', false))).toMatchObject({
      handle: '@bob@remote.example',
      routeHandle: 'bob@remote.example',
    })
  })

  it('falls back to the domain when is_local is missing, and drops Misskey\'s "." domain', () => {
    expect(toInteractionAccount('i3', profile('carol', 'remote.example', null)).routeHandle).toBe('carol@remote.example')
    expect(toInteractionAccount('i4', profile('dave', 'harmony.test', null)).routeHandle).toBe('dave')
    expect(toInteractionAccount('i5', profile('erin', '.', false)).handle).toBe('@erin')
  })

  it('uses the username when the display name is empty', () => {
    expect(toInteractionAccount('i6', { ...profile('fay', 'harmony.test', true), display_name: null }).displayName).toBe('fay')
  })
})
