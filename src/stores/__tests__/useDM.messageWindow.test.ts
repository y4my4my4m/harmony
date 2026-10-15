/**
 * The conversation list a jump detaches from the present, as in channels
 * (useChat.messageWindow.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadMessageWindow: vi.fn(),
  loadMessagesFrom: vi.fn(),
  loadConversationMessages: vi.fn(),
}))

vi.mock('@/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn(), fetchMultipleMessageReactions: vi.fn() }) }))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }), addEventListener: vi.fn(), removeEventListener: vi.fn() },
}))
vi.mock('@/utils/unifiedContentProcessing', () => ({ extractMentionsFromMessageParts: vi.fn(() => []) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (m: any[]) => m) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: { hasSubscription: vi.fn(() => false), unsubscribe: vi.fn(), subscribeToTable: vi.fn(() => vi.fn()) },
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { connect: vi.fn(), on: vi.fn(() => () => {}) } }))
vi.mock('@/services/readState', () => ({ fetchUnreadCounts: vi.fn(async () => []), markConversationRead: vi.fn(async () => {}) }))
vi.mock('@/composables/useFloatingVideo', () => ({ releaseFloatingVideo: vi.fn() }))

import { useDMStore } from '@/stores/useDM'
import { NEWER_PAGE } from '@/utils/messageWindow'

const CONV = 'conv-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `m${n}`,
  conversation_id: CONV,
  user_id: 'them',
  content: [{ type: 'text', text: `seq ${n}` }],
  created_at: new Date(T0 + n * 60_000).toISOString(),
  ...extra,
}) as any

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i))
const seqs = (list: Array<{ id: string }>) => list.map(m => m.id)

/** The conversation opened on its newest page, 280..299, then jumped to message 40. */
async function jumpedStore() {
  const store = useDMStore()
  store.currentConversationId = CONV
  messages.loadConversationMessages.mockResolvedValueOnce({ messages: rows(280, 299), hasMore: true })
  await store.fetchConversationMessages(CONV)
  messages.loadMessageWindow.mockResolvedValueOnce({ messages: rows(15, 65), allOlderLoaded: false, hasNewer: true })
  expect(await store.jumpToMessage('m40')).toBe(true)
  return store
}

describe('useDM message window', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(messages).forEach(fn => fn.mockReset())
  })

  it('replaces the list with the rows around a jump target, detached from the present', async () => {
    const store = await jumpedStore()
    expect(messages.loadMessageWindow).toHaveBeenCalledWith({ conversationId: CONV }, 'm40')
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(15, 65)))
    expect(store.hasNewerMessages).toBe(true)
  })

  it('keeps realtime rows past a detached list out of it and counts the other side', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300))
    store.addMessageToCache(row(301, { user_id: 'me' }))
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(15, 65)))
    expect(store.unseenWhileDetached).toBe(1)
  })

  it('appends pages toward the present contiguously and attaches on the short one', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300))
    const pages = [rows(66, 115), rows(116, 165), rows(166, 215), rows(216, 265), rows(266, 299)]
    for (const page of pages) messages.loadMessagesFrom.mockResolvedValueOnce({ messages: page, hasMore: page.length === NEWER_PAGE })
    for (let i = 0; i < pages.length; i++) {
      await store.fetchNewerMessages(CONV)
      expect(store.hasNewerMessages).toBe(i < pages.length - 1)
    }
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(15, 300)))
    expect(store.unseenWhileDetached).toBe(0)

    store.addMessageToCache(row(301))
    expect(store.currentDMMessages.at(-1)!.id).toBe('m301')
  })

  it('pages older history into a detached list and keeps the newest rows for the next open', async () => {
    const store = await jumpedStore()
    messages.loadConversationMessages.mockResolvedValueOnce({ messages: rows(0, 14), hasMore: false })
    await store.fetchConversationMessages(CONV, 'm15')
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(0, 65)))
    store.loadCachedMessages(CONV)
    expect(store.hasNewerMessages).toBe(false)
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(280, 299)))
  })

  it('returns to the present with the newest page', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300))
    messages.loadConversationMessages.mockResolvedValueOnce({ messages: rows(281, 300), hasMore: true })
    await store.reloadNewestPage(CONV)
    expect(store.hasNewerMessages).toBe(false)
    expect(seqs(store.currentDMMessages)).toEqual(seqs(rows(281, 300)))
  })
})
