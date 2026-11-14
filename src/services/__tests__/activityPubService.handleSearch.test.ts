// People search for a complete remote handle: search_federated_users reads stored profiles
// only, so an account of an instance this one never met is looked up through /lookup-user,
// once per handle and minute while it does not resolve.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ id: 'me' }) } }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

import { activityPubService, remoteHandleOf } from '@/services/activityPubService'
import type { FederatedUser } from '@/types'

const user = (id: string, username: string, domain: string, extra: Partial<FederatedUser> = {}) =>
  ({ id, username, domain, display_name: username, avatar_url: null, handle: `${username}@${domain}`, is_local: domain === 'home.test', ...extra }) as FederatedUser

let searchUsers: ReturnType<typeof vi.spyOn>
let getUserByHandle: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ;(activityPubService as any).currentDomain = 'home.test'
  ;(activityPubService as any).unresolvedHandles.clear()
  searchUsers = vi.spyOn(activityPubService, 'searchUsers')
  getUserByHandle = vi.spyOn(activityPubService, 'getUserByHandle')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('remoteHandleOf', () => {
  it('names a complete handle of another instance, lower case', () => {
    expect(remoteHandleOf('@MrsHlee@Har.Mony.lol', 'home.test')).toEqual({
      username: 'mrshlee', domain: 'har.mony.lol', key: 'mrshlee@har.mony.lol',
    })
    expect(remoteHandleOf(' alice@social.example.org ', 'home.test')?.key).toBe('alice@social.example.org')
  })

  it('names a dotted user of a bridge', () => {
    expect(remoteHandleOf('@hltv-mirror.eurosky.social@bsky.brid.gy', 'home.test')).toEqual({
      username: 'hltv-mirror.eurosky.social',
      domain: 'bsky.brid.gy',
      key: 'hltv-mirror.eurosky.social@bsky.brid.gy',
    })
    expect(remoteHandleOf('alice.bsky.social', 'home.test')).toBeNull()
  })

  it('is null for a name, an unfinished host, the local domain or two @', () => {
    for (const query of ['alice', 'alice@', 'alice@har', 'alice@har.', 'alice@har.m', 'alice@HOME.test', 'a@b@c.example', '@@x.example']) {
      expect(remoteHandleOf(query, 'home.test')).toBeNull()
    }
  })
})

describe('searchUsersResolvingHandle', () => {
  it('leaves a query that is no remote handle to the stored search', async () => {
    searchUsers.mockResolvedValue([user('l1', 'alice', 'home.test')])
    const found = await activityPubService.searchUsersResolvingHandle('alice', 10)
    expect(found.map((u) => u.id)).toEqual(['l1'])
    expect(getUserByHandle).not.toHaveBeenCalled()
  })

  it('looks up nothing when a stored profile is the handle', async () => {
    searchUsers.mockResolvedValue([user('r1', 'MrsHlee', 'har.mony.lol')])
    const found = await activityPubService.searchUsersResolvingHandle('mrshlee@har.mony.lol', 10)
    expect(found.map((u) => u.id)).toEqual(['r1'])
    expect(getUserByHandle).not.toHaveBeenCalled()
  })

  it('looks up an unseen handle and lists the stored profile first', async () => {
    const other = user('r2', 'mrshleeb', 'har.mony.lol')
    const stored = user('r1', 'mrshlee', 'har.mony.lol')
    searchUsers.mockResolvedValueOnce([other]).mockResolvedValueOnce([other, stored])
    getUserByHandle.mockResolvedValue(user('r1', 'mrshlee', 'har.mony.lol', { display_name: [{ type: 'text', content: 'x' }] as any }))

    const found = await activityPubService.searchUsersResolvingHandle('@mrshlee@har.mony.lol', 10)

    expect(getUserByHandle).toHaveBeenCalledWith('mrshlee@har.mony.lol')
    expect(found).toEqual([stored, other])
  })

  it('stands in the looked-up account when the stored search still lacks it', async () => {
    searchUsers.mockResolvedValue([])
    getUserByHandle.mockResolvedValue(user('r9', 'alice', 'example.com', { display_name: [{ type: 'emoji' }] as any }))

    const found = await activityPubService.searchUsersResolvingHandle('alice@social.example.com', 10)

    expect(found.map((u) => [u.id, u.display_name])).toEqual([['r9', 'alice']])
  })

  it('keeps the limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => user(`r${i}`, `bob${i}`, 'far.example'))
    searchUsers.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows)
    getUserByHandle.mockResolvedValue(user('n1', 'bob', 'far.example'))
    const found = await activityPubService.searchUsersResolvingHandle('bob@far.example', 3)
    expect(found.map((u) => u.id)).toEqual(['n1', 'r0', 'r1'])
  })

  it('repeats an unresolved lookup only after a minute', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    searchUsers.mockResolvedValue([])
    getUserByHandle.mockResolvedValue(null)

    expect(await activityPubService.searchUsersResolvingHandle('ghost@far.example', 10)).toEqual([])
    vi.setSystemTime(new Date('2026-11-06T00:00:59Z'))
    await activityPubService.searchUsersResolvingHandle('Ghost@Far.example', 10)
    expect(getUserByHandle).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-11-06T00:01:01Z'))
    await activityPubService.searchUsersResolvingHandle('ghost@far.example', 10)
    expect(getUserByHandle).toHaveBeenCalledTimes(2)
  })

  it('answers with the stored results when the lookup throws', async () => {
    searchUsers.mockResolvedValue([user('r2', 'carol2', 'far.example')])
    getUserByHandle.mockRejectedValue(new Error('429'))
    const found = await activityPubService.searchUsersResolvingHandle('carol@far.example', 10)
    expect(found.map((u) => u.id)).toEqual(['r2'])
  })
})
