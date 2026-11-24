import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
vi.mock('@/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (path: string) => path }))
import { fetchBridgedChannelUsers, fetchBridgedServerUsers, clearBridgedUsersCache, findBridgedUserInCache, bridgedUserKey, bridgedUserToProfileUser, isBridgedMatrixProfileUser, isBridgedDiscordProfileUser, bridgedAuthorColor, bridgedAuthorMember, bridgedProfileTarget, bridgedProfilePlatform, bridgedUserMatches } from '../bridgedChannelUsersService'
const request = vi.fn()
const matrix = { source: 'matrix' as const, id: '@sam:example.org', username: 'sam', displayName: 'Sam', avatarUrl: '' }
function respond(users: unknown[]) { request.mockResolvedValueOnce({ ok: true, json: async () => ({ has_bridge: true, users }) }) }
beforeEach(() => { clearBridgedUsersCache(); request.mockReset(); vi.stubGlobal('fetch', request) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('platform-qualified bridged member cache', () => {
  it('keeps the same external id on different platforms distinct across channel and server caches', async () => {
    respond([matrix, { ...matrix, source: 'discord', displayName: 'Discord Sam' }])
    const result = await fetchBridgedChannelUsers('channel')
    expect(result.users).toHaveLength(2)
    expect(bridgedUserKey(matrix)).toBe('matrix:@sam:example.org')
    expect(findBridgedUserInCache('channel', matrix.id, 'matrix')?.displayName).toBe('Sam')
    expect(findBridgedUserInCache('channel', matrix.id)?.displayName).toBe('Discord Sam')
    respond([{ ...matrix, displayName: 'Updated Matrix Sam' }])
    await fetchBridgedServerUsers('server')
    expect(findBridgedUserInCache(null, matrix.id, 'matrix')?.displayName).toBe('Updated Matrix Sam')
    expect(findBridgedUserInCache(null, matrix.id, 'discord')?.displayName).toBe('Discord Sam')
    await fetchBridgedChannelUsers('channel')
    expect(request).toHaveBeenCalledTimes(2)
    clearBridgedUsersCache()
    expect(findBridgedUserInCache(null, matrix.id, 'matrix')).toBeNull()
  })
  it('preserves legacy Discord payloads while rejecting unknown source and invalid Matrix identity', async () => {
    respond([{ id: '123', username: 'legacy' }, { ...matrix, avatarUrl: null }, { ...matrix, source: 'evil' }, { ...matrix, id: '123' }])
    expect((await fetchBridgedChannelUsers('channel')).users).toEqual([
      { id: '123', username: 'legacy', source: 'discord', displayName: 'legacy', avatarUrl: '' }, matrix,
    ])
  })
  it.each([
    [{ ...matrix }, 'matrix:@sam:example.org'],
    [{ ...matrix, source: 'discord' as const, id: '42' }, 'discord:42'],
  ])('adapts a bridged member into a profile card user the same way per platform', (member, id) => {
    const user = bridgedUserToProfileUser(member)
    expect(user).toMatchObject({ id, bridge_id: member.id, bridge_source: member.source, is_local: false, bridge_presence: false })
    expect(bridgedProfilePlatform(user)).toBe(member.source)
    expect(isBridgedMatrixProfileUser(user)).toBe(member.source === 'matrix')
    expect(isBridgedDiscordProfileUser(user)).toBe(member.source === 'discord')
    expect(bridgedUserToProfileUser({ ...member, presenceStatus: 'away' }).bridge_presence).toBe(true)
  })

  it.each([
    ['channel', () => fetchBridgedChannelUsers('channel')],
    ['server', () => fetchBridgedServerUsers('server')],
  ])('gives up on a gateway that never answers for a %s, and asks again the next time', async (_scope, ask) => {
    const timeout = new AbortController()
    const limit = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    request.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    const asked = ask()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(limit).toHaveBeenCalledWith(15_000)
    timeout.abort(new DOMException('signal timed out', 'TimeoutError'))
    expect(await asked).toEqual({ hasBridge: false, users: [] })
    limit.mockRestore()
    respond([matrix])
    expect((await ask()).users).toHaveLength(1)
  })

  it('finds a Matrix person by part of their id, a Discord person by the whole id only', () => {
    const sam = { ...matrix, username: 'quill', displayName: 'Quill' }
    const gus = { ...matrix, source: 'discord' as const, id: '1400000000000000103', username: 'gus', displayName: 'Gus 7' }
    expect(bridgedUserMatches(sam, 'example.org')).toBe(true)
    expect(bridgedUserMatches(sam, ' @SAM:')).toBe(true)
    expect(bridgedUserMatches(gus, '1')).toBe(false)
    expect(bridgedUserMatches(gus, '140000')).toBe(false)
    expect(bridgedUserMatches(gus, '1400000000000000103')).toBe(true)
    expect(bridgedUserMatches(gus, '7')).toBe(true)
    expect(bridgedUserMatches(gus, 'GU')).toBe(true)
    expect(bridgedUserMatches(gus, '')).toBe(true)
  })

  it('names the bridged person of a profile id', () => {
    expect(bridgedProfileTarget('discord:42')).toEqual({ platform: 'discord', id: '42', username: '42' })
    expect(bridgedProfileTarget('matrix:@sam:example.org')).toEqual({ platform: 'matrix', id: '@sam:example.org', username: 'sam' })
    expect(bridgedProfileTarget('@sam:example.org')).toEqual({ platform: 'matrix', id: '@sam:example.org', username: 'sam' })
    expect(bridgedProfileTarget('discord:')).toBeNull()
    expect(bridgedProfileTarget('matrix:javascript:alert(1)')).toBeNull()
    expect(bridgedProfileTarget('00000000-0000-4000-8000-000000000001')).toBeNull()
    expect(bridgedProfilePlatform({ id: '00000000-0000-4000-8000-000000000001' })).toBeNull()
  })

  it('colours a bridged author by the cached role colour, else the default, for both platforms', async () => {
    const roles = [{ id: 'r', name: 'Mod', color: '#ff0000', position: 1 }]
    respond([{ ...matrix, roles }, { ...matrix, source: 'discord', id: '42', roles }])
    await fetchBridgedChannelUsers('channel')
    expect(bridgedAuthorColor('matrix', matrix.id)).toBe('#ff0000')
    expect(bridgedAuthorColor('discord', '42')).toBe('#ff0000')
    expect(bridgedAuthorColor('matrix', '@lee:example.org')).toBe('var(--text-primary)')
    expect(bridgedAuthorColor('discord', '43')).toBe('var(--text-primary)')
    expect(bridgedAuthorColor(null, null)).toBe('var(--text-primary)')
    expect(bridgedAuthorMember({ platform: 'matrix', id: matrix.id, username: 'sam' }).roles).toEqual(roles)
    expect(bridgedAuthorMember({ platform: 'matrix', id: '@lee:example.org', username: '', display_name: 'Lee' }))
      .toEqual({ id: '@lee:example.org', username: 'lee', displayName: 'Lee', avatarUrl: '', source: 'matrix' })
  })

  it('recolours a name computed before the member list arrived, and again after a clear', async () => {
    const color = computed(() => bridgedAuthorColor('discord', '42'))
    expect(color.value).toBe('var(--text-primary)')
    respond([{ ...matrix, source: 'discord', id: '42', roles: [{ id: 'r', name: 'Mod', color: '#e67e22', position: 1 }] }])
    await fetchBridgedChannelUsers('channel')
    expect(color.value).toBe('#e67e22')
    clearBridgedUsersCache()
    expect(color.value).toBe('var(--text-primary)')
  })
})
