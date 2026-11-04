import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, type EffectScope } from 'vue'

// The call chat's own list while the routed view shows another chat: pages
// into the store's cache entry, one realtime subscription on the chat's topic
// while the routed store holds another chat, and the topic handed back when
// the store binds the call's chat.

const h = vi.hoisted(() => ({
  chat: null as any,
  dm: null as any,
  subs: new Map<string, any>(),
  subscribe: null as any,
  unsubscribe: null as any,
}))

vi.mock('@/stores/useChat', () => ({ useChatStore: () => h.chat }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => h.dm }))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn() }) }))
vi.mock('@/stores/useMessagePolls', () => ({ useMessagePollsStore: () => ({ applyRealtime: vi.fn() }) }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (rows: unknown[]) => rows) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: {
    subscribeBroadcast: (config: any) => h.subscribe(config),
    unsubscribe: (name: string) => h.unsubscribe(name),
  },
}))

import { useCallChatFeed } from '../callChatFeed'

let scope: EffectScope | null = null
const state = reactive({ target: null as any, routed: false })

const callChat = () => ({
  target: computed(() => state.target),
  routed: computed(() => state.routed),
}) as any

beforeEach(() => {
  h.subs.clear()
  h.subscribe = vi.fn((config: any) => { h.subs.set(config.channelName, config) })
  h.unsubscribe = vi.fn((name: string) => { h.subs.delete(name) })
  const cache = reactive(new Map<string, any>())
  h.chat = reactive({
    realtimeChannelId: 'lounge' as string | null,
    messageCache: cache,
    loadCachedChannelPage: vi.fn(async (id: string) => {
      if (!cache.has(id)) cache.set(id, { messages: [], allMessagesLoaded: true })
    }),
    addMessageToCache: vi.fn((m: any) => { cache.get(m.channel_id)?.messages.push(m) }),
    updateMessageInCache: vi.fn(),
    removeMessageFromCache: vi.fn(),
  })
  const conversations = reactive(new Map<string, any>())
  h.dm = reactive({
    currentConversationId: null as string | null,
    cachedConversation: (id: string) => conversations.get(id),
    loadCachedConversationPage: vi.fn(async (id: string) => {
      if (!conversations.has(id)) conversations.set(id, { messages: [], allMessagesLoaded: true })
    }),
    setupConversationSubscription: vi.fn(),
    addMessageToCache: vi.fn(),
    updateMessageInCache: vi.fn(),
    removeMessageFromCache: vi.fn(),
  })
  state.target = { kind: 'channel', serverId: 's1', channelId: 'lounge' }
  state.routed = false
  scope = effectScope()
})

afterEach(() => {
  scope?.stop()
  scope = null
})

const start = () => scope!.run(() => useCallChatFeed(callChat()))!

describe('useCallChatFeed: a voice channel', () => {
  it('loads the first page and subscribes once the routed store has left the channel', async () => {
    const feed = start()
    expect(feed.active.value).toBe(true)
    expect(h.chat.loadCachedChannelPage).toHaveBeenCalledWith('lounge', false)
    // The store's binding is still on the channel: its subscription delivers.
    expect(h.subscribe).not.toHaveBeenCalled()

    h.chat.realtimeChannelId = 'general'
    await nextTick()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    expect(h.subscribe.mock.calls[0][0].channelName).toBe('channel-messages-lounge')
    expect(h.chat.loadCachedChannelPage).toHaveBeenCalledTimes(1)
  })

  it('ends its subscription when the main window shows the channel', async () => {
    h.chat.realtimeChannelId = 'general'
    start()
    expect(h.subs.has('channel-messages-lounge')).toBe(true)
    state.routed = true
    await nextTick()
    expect(h.unsubscribe).toHaveBeenCalledWith('channel-messages-lounge')
  })

  it("leaves the topic to the store's own subscription when the store binds the channel", async () => {
    h.chat.realtimeChannelId = 'general'
    start()
    h.chat.realtimeChannelId = 'lounge'
    await nextTick()
    state.routed = true
    await nextTick()
    expect(h.unsubscribe).not.toHaveBeenCalled()
  })

  it('places a stored row over its optimistic one, and keeps thread replies out', async () => {
    h.chat.realtimeChannelId = 'general'
    const feed = start()
    await nextTick()
    const entry = h.chat.messageCache.get('lounge')
    entry.messages.push({ id: 'temp-1', user_id: 'me', channel_id: 'lounge', content: [{ type: 'text', text: 'hi' }], created_at: new Date(), metadata: { client_nonce: 'n1' }, sending: true })
    const deliver = async (row: any) => {
      const handler = h.subs.get('channel-messages-lounge').broadcasts.find((b: any) => b.event === 'message_event').handler
      await handler({ op: 'INSERT', new: row })
    }
    await deliver({ id: 'm1', user_id: 'me', channel_id: 'lounge', content: [{ type: 'text', text: 'hi' }], created_at: new Date().toISOString(), metadata: { client_nonce: 'n1' } })
    expect(feed.messages.value.map((m) => m.id)).toEqual(['m1'])
    await deliver({ id: 't1', user_id: 'bob', channel_id: 'lounge', thread_id: 'th', content: [], created_at: new Date().toISOString() })
    await deliver({ id: 'g1', user_id: 'bob', channel_id: 'general', content: [], created_at: new Date().toISOString() })
    expect(h.chat.addMessageToCache).not.toHaveBeenCalled()
    await deliver({ id: 'm2', user_id: 'bob', channel_id: 'lounge', content: [{ type: 'text', text: 'yo' }], created_at: new Date().toISOString() })
    expect(feed.messages.value.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('pages older rows into the entry and reports the paging state', async () => {
    const feed = start()
    await nextTick()
    expect(feed.listState.value).toEqual({ loadingOlder: false, allLoaded: true })
    await feed.loadOlder()
    expect(h.chat.loadCachedChannelPage).toHaveBeenLastCalledWith('lounge', true)
  })

  it('releases on unmount of its scope', () => {
    h.chat.realtimeChannelId = 'general'
    start()
    scope!.stop()
    scope = null
    expect(h.unsubscribe).toHaveBeenCalledWith('channel-messages-lounge')
  })
})

describe('useCallChatFeed: a direct message conversation', () => {
  beforeEach(() => {
    state.target = { kind: 'dm', conversationId: 'conv' }
  })

  it('subscribes while the DM store holds another conversation', () => {
    h.dm.currentConversationId = null
    start()
    expect(h.dm.loadCachedConversationPage).toHaveBeenCalledWith('conv', false)
    expect(h.subs.has('dm-conversation-conv')).toBe(true)
  })

  it('hands the topic back to the DM store when it opens the conversation', async () => {
    start()
    h.dm.currentConversationId = 'conv'
    await nextTick()
    expect(h.unsubscribe).toHaveBeenCalledWith('dm-conversation-conv')
    expect(h.dm.setupConversationSubscription).toHaveBeenCalledWith('conv')
  })

  it('is idle while the main window shows the conversation', () => {
    state.routed = true
    const feed = start()
    expect(feed.active.value).toBe(false)
    expect(h.dm.loadCachedConversationPage).not.toHaveBeenCalled()
    expect(h.subscribe).not.toHaveBeenCalled()
  })
})

describe('useCallChatFeed: no call', () => {
  it('holds nothing', () => {
    state.target = null
    const feed = start()
    expect(feed.active.value).toBe(false)
    expect(feed.messages.value).toEqual([])
    expect(ref(feed.loading.value).value).toBe(false)
  })
})
