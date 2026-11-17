import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (path: string) => path }))
import { fetchBridgedChannelUsers, fetchBridgedServerUsers, clearBridgedUsersCache, findBridgedUserInCache, bridgedUserKey, bridgedUserToProfileUser, isBridgedMatrixProfileUser, isBridgedDiscordProfileUser } from '../bridgedChannelUsersService'
const request = vi.fn()
const matrix = { source: 'matrix' as const, id: '@sam:example.org', username: 'sam', displayName: 'Sam', avatarUrl: '' }
function respond(users: unknown[]) { request.mockResolvedValueOnce({ ok: true, json: async () => ({ has_bridge: true, users }) }) }
beforeEach(() => { clearBridgedUsersCache(); request.mockReset(); vi.stubGlobal('fetch', request) })
afterEach(() => vi.unstubAllGlobals())
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
  it('adapts external Matrix identities without manufacturing a native profile or Discord id', () => {
    const user = bridgedUserToProfileUser(matrix)
    expect(user).toMatchObject({ id: 'matrix:@sam:example.org', matrix_id: matrix.id, bridge_source: 'matrix', is_local: false })
    expect(user.discord_id).toBeUndefined()
    expect(isBridgedMatrixProfileUser(user)).toBe(true)
    expect(isBridgedDiscordProfileUser(user)).toBe(false)
    expect(isBridgedMatrixProfileUser({ id: matrix.id })).toBe(true)
    expect(isBridgedMatrixProfileUser({ id: 'native-uuid' })).toBe(false)
  })
})
