import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { ServerBot } from '@/services/serverBotsService'

const { fetchServerBots } = vi.hoisted(() => ({ fetchServerBots: vi.fn() }))

vi.mock('@/services/serverBotsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/serverBotsService')>()
  return { ...actual, fetchServerBots }
})

import { SERVER_BOT_CHANGE_EVENT } from '@/services/serverBotsService'
import { SERVER_BOTS_REFETCH_MS, useServerBots } from '@/composables/useServerBots'

const bot = (id: string): ServerBot => ({
  id,
  username: id,
  displayName: id,
  avatarUrl: '/default_avatar.webp',
  botType: 'bot',
  status: 'online',
  activityType: null,
  statusText: '',
  sortKey: id,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const emit = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }))

describe('useServerBots', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchServerBots.mockReset()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('fetches the bots of the current server and refetches on a switch', async () => {
    const second = deferred<ServerBot[]>()
    fetchServerBots.mockResolvedValueOnce([bot('srv-1-bot')]).mockReturnValueOnce(second.promise)
    const serverId = ref<string | null>('srv-1')
    const { bots } = scope.run(() => useServerBots(serverId))!

    await vi.runAllTimersAsync()
    expect(bots.value.map(b => b.id)).toEqual(['srv-1-bot'])

    serverId.value = 'srv-2'
    await nextTick()
    expect(fetchServerBots).toHaveBeenLastCalledWith('srv-2')
    expect(bots.value).toEqual([])
    second.resolve([bot('srv-2-bot')])
    await vi.runAllTimersAsync()
    expect(bots.value.map(b => b.id)).toEqual(['srv-2-bot'])

    serverId.value = null
    await nextTick()
    expect(bots.value).toEqual([])
    expect(fetchServerBots).toHaveBeenCalledTimes(2)
  })

  it('drops a response for a server no longer selected', async () => {
    const first = deferred<ServerBot[]>()
    fetchServerBots.mockReturnValueOnce(first.promise).mockResolvedValueOnce([bot('second')])
    const serverId = ref('srv-1')
    const { bots } = scope.run(() => useServerBots(serverId))!

    serverId.value = 'srv-2'
    await vi.runAllTimersAsync()
    first.resolve([bot('first')])
    await vi.runAllTimersAsync()

    expect(bots.value.map(b => b.id)).toEqual(['second'])
  })

  it('collapses bot broadcasts for the current server into one refetch', async () => {
    fetchServerBots.mockResolvedValueOnce([]).mockResolvedValueOnce([bot('installed')])
    const { bots } = scope.run(() => useServerBots(() => 'srv-1'))!
    await vi.runAllTimersAsync()

    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:insert', server_id: 'srv-1', bot_id: 'installed' })
    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:presence', server_id: 'srv-1', bot_id: 'installed' })
    await vi.advanceTimersByTimeAsync(SERVER_BOTS_REFETCH_MS - 1)
    expect(fetchServerBots).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()

    expect(fetchServerBots).toHaveBeenCalledTimes(2)
    expect(bots.value.map(b => b.id)).toEqual(['installed'])
  })

  it('ignores broadcasts for other servers', async () => {
    fetchServerBots.mockResolvedValue([])
    scope.run(() => useServerBots(() => 'srv-1'))
    await vi.runAllTimersAsync()

    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:delete', server_id: 'srv-2', bot_id: 'b' })
    emit(SERVER_BOT_CHANGE_EVENT, null)
    await vi.runAllTimersAsync()

    expect(fetchServerBots).toHaveBeenCalledTimes(1)
  })

  it('refetches when a listed bot is edited and ignores unlisted ones', async () => {
    fetchServerBots.mockResolvedValue([bot('listed')])
    scope.run(() => useServerBots(() => 'srv-1'))
    await vi.runAllTimersAsync()

    emit('bot:updated', { id: 'unlisted', display_name: 'X' })
    await vi.runAllTimersAsync()
    expect(fetchServerBots).toHaveBeenCalledTimes(1)

    emit('bot:updated', { id: 'listed', display_name: 'Renamed' })
    await vi.runAllTimersAsync()
    expect(fetchServerBots).toHaveBeenCalledTimes(2)
  })

  it('keeps the list when a refetch fails', async () => {
    fetchServerBots.mockResolvedValueOnce([bot('kept')]).mockRejectedValueOnce(new Error('offline'))
    const { bots } = scope.run(() => useServerBots(() => 'srv-1'))!
    await vi.runAllTimersAsync()

    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:presence', server_id: 'srv-1', bot_id: 'kept' })
    await vi.runAllTimersAsync()

    expect(fetchServerBots).toHaveBeenCalledTimes(2)
    expect(bots.value.map(b => b.id)).toEqual(['kept'])
  })

  it('stops listening when its scope ends', async () => {
    fetchServerBots.mockResolvedValue([])
    scope.run(() => useServerBots(() => 'srv-1'))
    await vi.runAllTimersAsync()

    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:insert', server_id: 'srv-1', bot_id: 'b' })
    scope.stop()
    await vi.runAllTimersAsync()
    emit(SERVER_BOT_CHANGE_EVENT, { type: 'bot:insert', server_id: 'srv-1', bot_id: 'b' })
    await vi.runAllTimersAsync()

    expect(fetchServerBots).toHaveBeenCalledTimes(1)
  })
})
