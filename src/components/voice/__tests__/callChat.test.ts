import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref, type EffectScope } from 'vue'

// The call's side chat: which chat a call has, whether this user can read it
// here, when the routed view yields its list, the per-user open state and
// width, and the unread mark while the chat is hidden.

const h = vi.hoisted(() => ({
  voice: null as any,
  channels: null as any,
  dms: null as any,
  chat: null as any,
  unread: null as any,
  route: null as any,
  push: null as any,
  popped: null as any,
  user: 'u0',
  storage: new Map<string, string>(),
}))

vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.voice }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => h.channels }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => h.dms }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => h.chat }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/composables/useUnreadCounts', () => ({
  useUnreadCounts: () => ({
    getUnreadMessages: (ctx: { channelId?: string; conversationId?: string }) =>
      h.unread[ctx.conversationId ?? ctx.channelId ?? ''] ?? 0,
  }),
}))
vi.mock('@/services/DMCallSignaling', () => ({
  dmCallSignaling: { conversationForRoom: vi.fn(() => null) },
}))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getCurrentUser: () => h.user,
    getItem: (key: string) => h.storage.get(`${h.user}:${key}`) ?? null,
    setItem: (key: string, value: string) => { h.storage.set(`${h.user}:${key}`, value) },
  },
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ currentRoute: h.route, push: h.push }),
}))
vi.mock('../callPopout', async () => {
  const { computed } = await import('vue')
  return { callPopoutActive: computed(() => h.popped.value) }
})

import { CALL_CHAT_WIDTH, clampCallChatWidth, setCallChatOpen, setCallChatWidth, useCallChat, useCallChatUnread } from '../callChat'
import { dmCallSignaling } from '@/services/DMCallSignaling'

const CONV = '11111111-2222-3333-4444-555555555555'
let users = 0
let scope: EffectScope | null = null

beforeEach(() => {
  h.user = `user-${++users}`
  h.voice = reactive({ currentChannelId: 'lounge', currentServerId: 's1', isConnectedOrJoining: true, isOverlayVisible: true })
  h.channels = reactive({ channels: [{ id: 'lounge' }], _structureCacheByServer: {} })
  h.dms = reactive({ conversations: [{ id: CONV }], currentConversationId: null, currentDMMessages: [] })
  h.chat = reactive({ currentChannelId: 'lounge', messages: [] as any[] })
  h.unread = reactive({})
  h.route = ref({ name: 'ChatChannel', params: { serverId: 's1', channelId: 'lounge' } })
  h.push = vi.fn(async () => {})
  h.popped = ref(false)
  scope = effectScope()
})

afterEach(() => {
  scope?.stop()
  scope = null
})

const inScope = <T>(fn: () => T): T => scope!.run(fn)!

describe('useCallChat target', () => {
  it("is the voice channel's chat for a server call", () => {
    const chat = inScope(useCallChat)
    expect(chat.target.value).toEqual({ kind: 'channel', serverId: 's1', channelId: 'lounge' })
  })

  it('is the conversation for a DM call, federated rooms included', () => {
    h.voice.currentServerId = 'dm'
    h.voice.currentChannelId = `dm-${CONV}`
    const chat = inScope(useCallChat)
    expect(chat.target.value).toEqual({ kind: 'dm', conversationId: CONV })
    h.voice.currentChannelId = `federated-dm-${CONV}-1700000000`
    expect(chat.target.value).toEqual({ kind: 'dm', conversationId: CONV })
    vi.mocked(dmCallSignaling.conversationForRoom).mockReturnValueOnce('mapped')
    h.voice.currentChannelId = `federated-dm-${CONV}-1700000001`
    expect(chat.target.value).toEqual({ kind: 'dm', conversationId: 'mapped' })
  })

  it('is none outside a call', () => {
    h.voice.isConnectedOrJoining = false
    expect(inScope(useCallChat).target.value).toBeNull()
  })
})

describe('useCallChat availability', () => {
  it('needs the channel among the ones this user sees, or the conversation among theirs', () => {
    const chat = inScope(useCallChat)
    expect(chat.available.value).toBe(true)
    h.channels.channels = []
    expect(chat.available.value).toBe(false)
    // A federated server's channels can sit in the structure cache only.
    h.channels._structureCacheByServer = { s1: { channels: [{ id: 'lounge' }] } }
    expect(chat.available.value).toBe(true)

    h.voice.currentServerId = 'dm'
    h.voice.currentChannelId = `dm-${CONV}`
    expect(chat.available.value).toBe(true)
    h.dms.conversations = []
    expect(chat.available.value).toBe(false)
  })
})

describe('useCallChat placement', () => {
  it('shows while open with the call view shown, in the app or popped out', () => {
    const chat = inScope(useCallChat)
    expect(chat.shown.value).toBe(false)
    setCallChatOpen(true)
    expect(chat.shown.value).toBe(true)
    h.voice.isOverlayVisible = false
    expect(chat.shown.value).toBe(false)
    h.popped.value = true
    expect(chat.shown.value).toBe(true)
  })

  it('has the routed view yield only for the call chat while it shows', () => {
    const chat = inScope(useCallChat)
    expect(chat.hosts({ channelId: 'lounge' })).toBe(false)
    setCallChatOpen(true)
    expect(chat.hosts({ channelId: 'lounge' })).toBe(true)
    expect(chat.hosts({ channelId: 'general' })).toBe(false)
    expect(chat.hosts({ conversationId: CONV })).toBe(false)
  })

  it("routes the main window to the call's chat only when it shows another", () => {
    const chat = inScope(useCallChat)
    expect(chat.routed.value).toBe(true)
    chat.showTarget()
    expect(h.push).not.toHaveBeenCalled()

    h.route.value = { name: 'ChatChannel', params: { serverId: 's1', channelId: 'general' } }
    expect(chat.routed.value).toBe(false)
    chat.showTarget()
    expect(h.push).toHaveBeenCalledWith({ name: 'ChatChannel', params: { serverId: 's1', channelId: 'lounge' } })

    h.voice.currentServerId = 'dm'
    h.voice.currentChannelId = `dm-${CONV}`
    chat.showTarget()
    expect(h.push).toHaveBeenLastCalledWith({ name: 'DMConversation', params: { conversationId: CONV } })
  })
})

describe('stored choices', () => {
  it('remembers open and width per user', () => {
    const first = h.user
    setCallChatOpen(true)
    setCallChatWidth(420)
    expect(inScope(useCallChat).open.value).toBe(true)

    h.user = 'someone-else'
    const other = inScope(useCallChat)
    expect(other.open.value).toBe(false)
    expect(other.width.value).toBe(CALL_CHAT_WIDTH.initial)

    h.user = first
    const back = inScope(useCallChat)
    expect(back.open.value).toBe(true)
    expect(back.width.value).toBe(420)
  })

  it('clamps the width', () => {
    expect(clampCallChatWidth(10)).toBe(CALL_CHAT_WIDTH.min)
    expect(clampCallChatWidth(5000)).toBe(CALL_CHAT_WIDTH.max)
    expect(clampCallChatWidth(Number.NaN)).toBe(CALL_CHAT_WIDTH.initial)
    expect(clampCallChatWidth(333.4)).toBe(333)
  })
})

describe('useCallChatUnread', () => {
  const message = (id: string, user = 'bob') => ({ id, user_id: user })

  it("marks a newer message from someone else while hidden, and clears when shown", async () => {
    h.chat.messages = [message('m1')]
    const chat = inScope(useCallChat)
    const unread = inScope(() => useCallChatUnread(chat))
    await nextTick()
    expect(unread.value).toBe(false)

    h.chat.messages.push(message('m2', 'me'))
    await nextTick()
    expect(unread.value).toBe(false)

    h.chat.messages.push(message('temp-3', 'bob'))
    await nextTick()
    expect(unread.value).toBe(false)

    h.chat.messages.push(message('m4'))
    await nextTick()
    expect(unread.value).toBe(true)

    setCallChatOpen(true)
    await nextTick()
    expect(unread.value).toBe(false)
    setCallChatOpen(false)
    await nextTick()
    expect(unread.value).toBe(false)
  })

  it("ignores another channel's list and reads the chat's unread count", async () => {
    h.chat.currentChannelId = 'general'
    h.chat.messages = [message('g1')]
    const chat = inScope(useCallChat)
    const unread = inScope(() => useCallChatUnread(chat))
    h.chat.messages.push(message('g2'))
    await nextTick()
    expect(unread.value).toBe(false)
    h.unread.lounge = 2
    expect(unread.value).toBe(true)
  })
})
