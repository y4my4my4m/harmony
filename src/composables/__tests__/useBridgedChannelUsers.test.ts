import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
const { fetchUsers } = vi.hoisted(() => ({ fetchUsers: vi.fn() }))
vi.mock('@/services/bridgedChannelUsersService', () => ({ fetchBridgedChannelUsers: fetchUsers }))
import { useBridgedChannelUsers } from '../useBridgedChannelUsers'
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const matrix = (id: string) => ({ id, source: 'matrix' })
const discord = (id: string) => ({ id, source: 'discord', presenceStatus: 'online' })
afterEach(() => { vi.useRealTimers(); fetchUsers.mockReset() })

describe('bridged member request scope', () => {
  it('discards an old channel response and never starts an old-channel poll', async () => {
    vi.useFakeTimers()
    const old = deferred(), current = deferred()
    fetchUsers.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const channel = ref<string | null>('old'), scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers(channel, 'server'))!
    channel.value = 'new'; await nextTick()
    current.resolve({ hasBridge: true, users: [discord('2')] }); await flushPromises()
    expect(members.users.value[0].id).toBe('2')
    old.resolve({ hasBridge: true, users: [discord('1')] }); await flushPromises()
    expect(members.users.value[0].id).toBe('2')
    expect(vi.getTimerCount()).toBe(1)
    channel.value = null; await nextTick()
    expect(members.users.value).toEqual([])
    expect(members.loading.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    scope.stop()
  })

  it('within a server, keeps the previous channel list on screen until the next one arrives', async () => {
    const next = deferred()
    fetchUsers.mockResolvedValueOnce({ hasBridge: true, users: [matrix('@sam:a.hs')] }).mockReturnValueOnce(next.promise)
    const channel = ref('a'), scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers(channel, 'server'))!
    await flushPromises()
    channel.value = 'b'; await nextTick()
    expect(members.users.value.map(user => user.id)).toEqual(['@sam:a.hs'])
    expect(members.hasBridge.value).toBe(true)
    next.resolve({ hasBridge: true, users: [matrix('@lee:b.hs')] }); await flushPromises()
    expect(members.users.value.map(user => user.id)).toEqual(['@lee:b.hs'])
    scope.stop()
  })

  it('a channel of another server starts from an empty list', async () => {
    const next = deferred()
    fetchUsers.mockResolvedValueOnce({ hasBridge: true, users: [matrix('@sam:a.hs')] }).mockReturnValueOnce(next.promise)
    const channel = ref('a'), server = ref('one'), scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers(channel, server))!
    await flushPromises()
    expect(members.users.value).toHaveLength(1)
    server.value = 'two'; channel.value = 'b'; await nextTick()
    expect(members.users.value).toEqual([])
    expect(members.hasBridge.value).toBe(false)
    next.resolve({ hasBridge: true, users: [matrix('@lee:b.hs')] }); await flushPromises()
    expect(members.users.value.map(user => user.id)).toEqual(['@lee:b.hs'])
    expect(members.hasBridge.value).toBe(true)
    scope.stop()
  })

  it('a server named after its channel keeps the channel list', async () => {
    fetchUsers.mockResolvedValueOnce({ hasBridge: true, users: [matrix('@sam:a.hs')] })
    const server = ref<string | null>(null), scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers('a', server))!
    await flushPromises()
    server.value = 'one'; await nextTick()
    expect(members.users.value).toHaveLength(1)
    expect(fetchUsers).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('polls only while a member reports presence', async () => {
    vi.useFakeTimers()
    fetchUsers.mockResolvedValueOnce({ hasBridge: true, users: [matrix('@sam:hs')] })
      .mockResolvedValueOnce({ hasBridge: true, users: [matrix('@sam:hs'), discord('1')] })
    const channel = ref('matrix-only'), scope = effectScope()
    scope.run(() => useBridgedChannelUsers(channel, 'server'))
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    channel.value = 'mixed'; await nextTick(); await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    scope.stop()
  })

  it('does not restart polling or apply results after disposal', async () => {
    vi.useFakeTimers()
    const pending = deferred(); fetchUsers.mockReturnValueOnce(pending.promise)
    const scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers('channel', 'server'))!
    scope.stop()
    pending.resolve({ hasBridge: true, users: [discord('1')] }); await flushPromises()
    expect(members.users.value).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
