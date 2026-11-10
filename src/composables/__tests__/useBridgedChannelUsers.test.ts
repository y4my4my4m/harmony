import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
const { fetchUsers } = vi.hoisted(() => ({ fetchUsers: vi.fn() }))
vi.mock('@/services/bridgedChannelUsersService', () => ({ fetchBridgedChannelUsers: fetchUsers }))
import { useBridgedChannelUsers } from '../useBridgedChannelUsers'
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
afterEach(() => { vi.useRealTimers(); fetchUsers.mockReset() })
describe('bridged member request scope', () => {
  it('discards an old channel response and never starts an old-channel poll', async () => {
    vi.useFakeTimers()
    const old = deferred(), current = deferred()
    fetchUsers.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const channel = ref<string | null>('old'), scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers(channel))!
    channel.value = 'new'; await nextTick()
    current.resolve({ hasBridge: true, users: [{ id: '@sam:new.hs', source: 'matrix' }] }); await flushPromises()
    expect(members.users.value[0].id).toBe('@sam:new.hs')
    old.resolve({ hasBridge: true, users: [{ id: '@sam:old.hs', source: 'matrix' }] }); await flushPromises()
    expect(members.users.value[0].id).toBe('@sam:new.hs')
    expect(vi.getTimerCount()).toBe(1)
    channel.value = null; await nextTick()
    expect(members.users.value).toEqual([])
    expect(members.loading.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    scope.stop()
  })
  it('does not restart polling or apply results after disposal', async () => {
    vi.useFakeTimers()
    const pending = deferred(); fetchUsers.mockReturnValueOnce(pending.promise)
    const scope = effectScope()
    const members = scope.run(() => useBridgedChannelUsers('channel'))!
    scope.stop()
    pending.resolve({ hasBridge: true, users: [{ id: '@sam:hs', source: 'matrix' }] }); await flushPromises()
    expect(members.users.value).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
