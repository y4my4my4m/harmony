// Unread state comes from get_unread_counts and read markers go through the mark_* RPCs;
// the client never reads or writes unread_counts directly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { supabase } from '@/supabase'

const handlers = new Map<string, (data: Record<string, any>) => void>()
const applyContextRead = vi.hoisted(() => vi.fn())

vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ applyContextRead }),
}))

vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    connect: vi.fn(),
    on: vi.fn((type: string, handler: (data: Record<string, any>) => void) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    }),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: true, profileId: 'me' }),
  },
}))

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const rpc = vi.mocked(supabase.rpc)

const row = (over: Record<string, unknown>) => ({
  id: null,
  user_id: 'me',
  server_id: null,
  channel_id: null,
  conversation_id: null,
  unread_messages: 0,
  unread_mentions: 0,
  last_read_message_id: null,
  last_read_at: '2026-10-01T00:00:00Z',
  last_message_at: '2026-10-01T01:00:00Z',
  ...over,
})

describe('useUnreadCounts', () => {
  beforeEach(() => {
    rpc.mockReset()
    handlers.clear()
    // onMounted/onUnmounted outside a component instance.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('loads counts from get_unread_counts and keys them by context', async () => {
    rpc.mockResolvedValue({
      data: [
        row({ server_id: 's1', channel_id: 'c1', unread_messages: 3 }),
        row({ server_id: 's1', channel_id: 'c2', unread_mentions: 2 }),
        row({ conversation_id: 'd1', unread_messages: 7 }),
      ],
      error: null,
    } as any)

    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()

    expect(rpc).toHaveBeenCalledWith('get_unread_counts')
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalledWith('unread_counts')
    expect(unread.getUnreadMessages({ channelId: 'c1' })).toBe(3)
    expect(unread.getUnreadMentions({ channelId: 'c2' })).toBe(2)
    expect(unread.getUnreadMessages({ conversationId: 'd1' })).toBe(7)
    expect(unread.getServerUnreadMessages('s1')).toBe(3)
    expect(unread.getServerUnreadMentions('s1')).toBe(2)
    unread.cleanup()
  })

  it('applies unread:change upserts, keeping the read boundary, and deletes', async () => {
    rpc.mockResolvedValue({ data: [], error: null } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()
    await unread.fetchUnreadCounts()

    const onChange = handlers.get('unread:change')
    expect(onChange).toBeDefined()
    onChange!({
      type: 'unread:change',
      action: 'upsert',
      count: row({ server_id: 's1', channel_id: 'c9', unread_messages: 1, last_read_message_id: 'm4' }),
    })
    expect(unread.getUnreadMessages({ channelId: 'c9' })).toBe(1)
    expect(unread.getUnreadCount({ channelId: 'c9' })?.last_read_message_id).toBe('m4')

    onChange!({ type: 'unread:change', action: 'delete', count: row({ server_id: 's1', channel_id: 'c9' }) })
    expect(unread.getUnreadCount({ channelId: 'c9' })).toBeNull()
    unread.cleanup()
  })
})

describe('readState', () => {
  beforeEach(() => {
    rpc.mockReset()
    applyContextRead.mockReset()
  })

  it('marks channels, conversations and servers read through the RPCs', async () => {
    rpc.mockResolvedValue({ data: null, error: null } as any)
    const { markChannelRead, markConversationRead, markServerRead } = await import('@/services/readState')

    await markChannelRead('c1', 'm1')
    await markChannelRead('c2')
    await markConversationRead('d1', 'm2')
    await markServerRead('s1')

    expect(rpc.mock.calls).toEqual([
      ['mark_channel_as_read', { p_channel_id: 'c1', p_message_id: 'm1' }],
      ['mark_channel_as_read', { p_channel_id: 'c2', p_message_id: null }],
      ['mark_conversation_as_read', { p_conversation_id: 'd1', p_message_id: 'm2' }],
      ['mark_server_as_read', { p_server_id: 's1' }],
    ])
  })

  it('a channel or conversation read marks the loaded notifications of the whole context read', async () => {
    rpc.mockResolvedValue({ data: null, error: null } as any)
    const { markChannelRead, markConversationRead } = await import('@/services/readState')

    await markChannelRead('c1', 'm1')
    await markConversationRead('d1', 'm2')

    expect(applyContextRead.mock.calls).toEqual([['channel', 'c1'], ['conversation', 'd1']])
  })

  it('surfaces an RPC error and leaves the notifications', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Not authenticated' } } as any)
    const { markChannelRead, fetchUnreadCounts } = await import('@/services/readState')

    await expect(markChannelRead('c1')).rejects.toThrow('Not authenticated')
    await expect(fetchUnreadCounts()).rejects.toThrow('Not authenticated')
    expect(applyContextRead).not.toHaveBeenCalled()
  })
})

describe('muted contexts', () => {
  beforeEach(() => {
    rpc.mockReset()
    handlers.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('a muted channel adds its mentions to the server, not its frozen messages', async () => {
    rpc.mockResolvedValue({
      data: [
        row({ server_id: 's1', channel_id: 'c1', unread_messages: 4, muted: true }),
        row({ server_id: 's1', channel_id: 'c2', unread_messages: 2, unread_mentions: 1, muted: true }),
        row({ server_id: 's2', channel_id: 'c3', unread_messages: 3, muted: true }),
        row({ server_id: 's2', channel_id: 'c4', unread_messages: 1 }),
      ],
      error: null,
    } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()

    expect(unread.getServerUnreadMessages('s1')).toBe(0)
    expect(unread.getServerUnreadMentions('s1')).toBe(1)
    expect(unread.getServerUnreadMessages('s2')).toBe(1)
    // The channel's own count stays for its divider.
    expect(unread.getUnreadMessages({ channelId: 'c1' })).toBe(4)
    unread.cleanup()
  })

  it('follows muted on unread:change, both ways', async () => {
    rpc.mockResolvedValue({ data: [row({ server_id: 's1', channel_id: 'c1', unread_messages: 2 })], error: null } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()
    await unread.fetchUnreadCounts()
    expect(unread.getServerUnreadMessages('s1')).toBe(2)

    const onChange = handlers.get('unread:change')!
    onChange({ action: 'upsert', count: row({ server_id: 's1', channel_id: 'c1', unread_messages: 2, muted: true }) })
    expect(unread.getServerUnreadMessages('s1')).toBe(0)
    onChange({ action: 'upsert', count: row({ server_id: 's1', channel_id: 'c1', unread_messages: 2, muted: false }) })
    expect(unread.getServerUnreadMessages('s1')).toBe(2)
    unread.cleanup()
  })
})

describe('fetches and events', () => {
  beforeEach(() => {
    rpc.mockReset()
    handlers.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const deferred = () => {
    let resolve!: (v: unknown) => void
    const promise = new Promise((r) => { resolve = r })
    return { promise, resolve }
  }

  it('registers the event handler before the first fetch', async () => {
    let registeredAtFetch = false
    rpc.mockImplementation((() => {
      registeredAtFetch = handlers.has('unread:change')
      return Promise.resolve({ data: [], error: null })
    }) as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()

    expect(registeredAtFetch).toBe(true)
    unread.cleanup()
  })

  it('applies events received during a fetch over its snapshot', async () => {
    rpc.mockResolvedValue({ data: [], error: null } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()

    const pending = deferred()
    rpc.mockReturnValueOnce(pending.promise as any)
    const fetching = unread.fetchUnreadCounts()
    const onChange = handlers.get('unread:change')!
    onChange({ action: 'upsert', count: row({ server_id: 's1', channel_id: 'new', unread_messages: 1 }) })
    onChange({ action: 'delete', count: row({ server_id: 's1', channel_id: 'read' }) })

    // The snapshot predates both events.
    pending.resolve({
      data: [row({ server_id: 's1', channel_id: 'read', unread_messages: 5 }), row({ server_id: 's1', channel_id: 'other', unread_messages: 1 })],
      error: null,
    })
    await fetching

    expect(unread.getUnreadMessages({ channelId: 'new' })).toBe(1)
    expect(unread.getUnreadCount({ channelId: 'read' })).toBeNull()
    expect(unread.getUnreadMessages({ channelId: 'other' })).toBe(1)

    // Events after the fetch apply as usual and are not replayed by the next one.
    rpc.mockResolvedValueOnce({ data: [], error: null } as any)
    await unread.fetchUnreadCounts()
    expect(unread.getUnreadCount({ channelId: 'new' })).toBeNull()
    unread.cleanup()
  })

  it('drops a fetch overtaken by a later one', async () => {
    rpc.mockResolvedValue({ data: [], error: null } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()

    const slow = deferred()
    rpc.mockReturnValueOnce(slow.promise as any)
    const first = unread.fetchUnreadCounts()
    rpc.mockResolvedValueOnce({ data: [row({ server_id: 's1', channel_id: 'c1', unread_messages: 1 })], error: null } as any)
    await unread.fetchUnreadCounts()
    slow.resolve({ data: [row({ server_id: 's1', channel_id: 'stale', unread_messages: 9 })], error: null })
    await first

    expect(unread.getUnreadMessages({ channelId: 'c1' })).toBe(1)
    expect(unread.getUnreadCount({ channelId: 'stale' })).toBeNull()
    unread.cleanup()
  })

  it('refetches when the tab becomes visible or focused, at most every 30 s, and every 5 min', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    rpc.mockResolvedValue({ data: [], error: null } as any)
    const { useUnreadCounts } = await import('@/composables/useUnreadCounts')
    const unread = useUnreadCounts()
    await unread.initialize()
    const fetches = () => rpc.mock.calls.filter(([fn]) => fn === 'get_unread_counts').length
    const initial = fetches()

    vi.setSystemTime(new Date('2030-01-01T00:00:10Z'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetches()).toBe(initial)

    vi.setSystemTime(new Date('2030-01-01T00:00:31Z'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetches()).toBe(initial + 1)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetches()).toBe(initial + 2)

    unread.cleanup()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetches()).toBe(initial + 2)
  })
})
