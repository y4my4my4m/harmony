// Unread state comes from get_unread_counts and read markers go through the mark_* RPCs;
// the client never reads or writes unread_counts directly.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'

const handlers = new Map<string, (data: Record<string, any>) => void>()

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

  it('surfaces an RPC error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Not authenticated' } } as any)
    const { markChannelRead, fetchUnreadCounts } = await import('@/services/readState')

    await expect(markChannelRead('c1')).rejects.toThrow('Not authenticated')
    await expect(fetchUnreadCounts()).rejects.toThrow('Not authenticated')
  })
})
