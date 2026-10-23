/**
 * Opening a remote channel shows its cached rows, then checks them against the host once.
 * Rows the check added or completed replace their loaded copies and join the loaded span,
 * older pages kept; the channel's cache entry is dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadChannelMessages: vi.fn(),
  refreshRemoteChannel: vi.fn(),
}))
const structure = vi.hoisted(() => ({
  channels: [
    { id: 'remote-1', server_id: 'copy' },
    { id: 'local-1', server_id: 'home' },
  ],
  servers: [
    { id: 'copy', is_local_server: false },
    { id: 'home', is_local_server: true },
  ],
  _structureCacheByServer: {},
}))

vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => structure }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useChatStore } from '@/stores/useChat'

const row = (channel: string, id: string, minute: number, parts: any[] = [{ type: 'text', text: id }]) => ({
  id,
  channel_id: channel,
  user_id: 'author',
  content: parts,
  created_at: new Date(Date.parse('2026-10-01T00:00:00Z') + minute * 60_000).toISOString(),
}) as any

const file = { type: 'file', fileType: 'image', url: 'https://host.test/media/c/x/a.png?to=copy.test&sig=s' }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('useChat remote channel refresh', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(messages).forEach(fn => fn.mockReset())
  })

  it('reloads the newest page when the host check changed rows', async () => {
    messages.loadChannelMessages
      .mockResolvedValueOnce({ messages: [row('remote-1', 'a', 1, [{ type: 'text', text: 'look' }])], hasMore: false })
      .mockResolvedValueOnce({
        messages: [row('remote-1', 'a', 1, [{ type: 'text', text: 'look' }, file]), row('remote-1', 'b', 2, [file])],
        hasMore: false,
      })
    messages.refreshRemoteChannel.mockResolvedValueOnce(true)
    const store = useChatStore()

    await store.fetchMessages('remote-1')
    await flush()

    expect(messages.refreshRemoteChannel).toHaveBeenCalledWith('remote-1')
    expect(messages.loadChannelMessages).toHaveBeenCalledTimes(2)
    expect(store.messages.map((m: any) => m.id)).toEqual(['a', 'b'])
    expect(store.messages[0].content).toContainEqual(file)
  })

  it('keeps older pages already loaded and adds only rows inside the loaded span', async () => {
    messages.loadChannelMessages.mockResolvedValueOnce({
      messages: [row('remote-1', 'old', 1), row('remote-1', 'a', 10, [{ type: 'text', text: 'look' }])],
      hasMore: true,
    })
    let answer!: (changed: boolean) => void
    messages.refreshRemoteChannel.mockReturnValueOnce(new Promise<boolean>(resolve => { answer = resolve }))
    const store = useChatStore()
    await store.fetchMessages('remote-1')
    // An older page joins the list before the check answers.
    store.messages = [row('remote-1', 'older', 0), ...store.messages]
    messages.loadChannelMessages.mockResolvedValueOnce({
      messages: [row('remote-1', 'before-span', -5, [file]), row('remote-1', 'a', 10, [{ type: 'text', text: 'look' }, file]), row('remote-1', 'b', 11, [file])],
      hasMore: true,
    })
    answer(true)
    await flush()

    expect(store.messages.map((m: any) => m.id)).toEqual(['older', 'old', 'a', 'b'])
    expect(store.messages[2].content).toContainEqual(file)
    expect(messages.loadChannelMessages).toHaveBeenLastCalledWith('remote-1', { limit: 50, isRemote: true })
  })

  it('keeps the list when nothing changed', async () => {
    messages.loadChannelMessages.mockResolvedValueOnce({ messages: [row('remote-1', 'a', 1)], hasMore: false })
    messages.refreshRemoteChannel.mockResolvedValueOnce(false)
    const store = useChatStore()

    await store.fetchMessages('remote-1')
    await flush()

    expect(messages.loadChannelMessages).toHaveBeenCalledTimes(1)
    expect(store.messages.map((m: any) => m.id)).toEqual(['a'])
  })

  it('checks nothing for a local channel', async () => {
    messages.loadChannelMessages.mockResolvedValueOnce({ messages: [row('local-1', 'l', 1)], hasMore: false })
    const store = useChatStore()

    await store.fetchMessages('local-1')
    await flush()

    expect(messages.refreshRemoteChannel).not.toHaveBeenCalled()
  })

  it('drops the cache entry of a channel left before the check answered', async () => {
    let answer!: (changed: boolean) => void
    messages.refreshRemoteChannel.mockReturnValueOnce(new Promise<boolean>(resolve => { answer = resolve }))
    messages.loadChannelMessages
      .mockResolvedValueOnce({ messages: [row('remote-1', 'a', 1)], hasMore: false })
      .mockResolvedValueOnce({ messages: [row('local-1', 'l', 1)], hasMore: false })
    const store = useChatStore()

    await store.fetchMessages('remote-1')
    await store.fetchMessages('local-1')
    expect(store.messageCache.has('remote-1')).toBe(true)

    answer(true)
    await flush()

    expect(store.messageCache.has('remote-1')).toBe(false)
    expect(store.messages.map((m: any) => m.id)).toEqual(['l'])
    expect(messages.loadChannelMessages).toHaveBeenCalledTimes(2)
  })
})
