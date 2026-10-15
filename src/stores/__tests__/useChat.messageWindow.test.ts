/**
 * The channel list a jump detaches from the present: the rows around the target
 * replace it, realtime rows past its end stay out, pages toward the present extend
 * it contiguously, and the page that reaches the newest message attaches it again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadMessageWindow: vi.fn(),
  loadMessagesFrom: vi.fn(),
  loadChannelMessages: vi.fn(),
}))

vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ channels: [], servers: [], _structureCacheByServer: {} }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useChatStore } from '@/stores/useChat'
import { NEWER_PAGE } from '@/utils/messageWindow'

const CH = 'chan-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')

/** Message `n` of the channel, n minutes after T0. */
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `m${n}`,
  channel_id: CH,
  user_id: 'author',
  content: [{ type: 'text', text: `seq ${n}` }],
  created_at: new Date(T0 + n * 60_000).toISOString(),
  ...extra,
}) as any

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i))
const seqs = (list: Array<{ id: string }>) => list.map(m => m.id)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** The store open on the channel's newest page, 280..299, the cache holding the same. */
function openStore() {
  const store = useChatStore()
  store.currentChannelId = CH
  store.messages = rows(280, 299)
  store.allMessagesLoaded = false
  store.messageCache.set(CH, {
    messages: rows(280, 299),
    lastFetchedAt: new Date(),
    oldestMessageId: 'm280',
    allMessagesLoaded: false,
    lastModified: new Date(),
  })
  return store
}

/** The store after a jump to message 40: rows 15..65, detached. */
async function jumpedStore() {
  const store = openStore()
  messages.loadMessageWindow.mockResolvedValueOnce({ messages: rows(15, 65), allOlderLoaded: false, hasNewer: true })
  expect(await store.jumpToMessage('m40', CH)).toBe(true)
  return store
}

describe('useChat message window', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(messages).forEach(fn => fn.mockReset())
  })

  it('replaces the list with the rows around a jump target, detached from the present', async () => {
    const store = await jumpedStore()
    expect(messages.loadMessageWindow).toHaveBeenCalledWith({ channelId: CH }, 'm40', { isRemote: undefined })
    expect(seqs(store.messages)).toEqual(seqs(rows(15, 65)))
    expect(store.hasNewerMessages).toBe(true)
    expect(store.allMessagesLoaded).toBe(false)
    // The cache keeps the newest rows for the next open.
    expect(seqs(store.messageCache.get(CH)!.messages)).toEqual(seqs(rows(280, 299)))
  })

  it('highlights a target already in the list without a load', async () => {
    const store = openStore()
    const highlight = vi.fn()
    store.highlightMessage = highlight
    expect(await store.jumpToMessage('m290', CH)).toBe(true)
    expect(messages.loadMessageWindow).not.toHaveBeenCalled()
    expect(highlight).toHaveBeenCalledWith('m290')
  })

  it('reports a target that is not a visible message of the channel', async () => {
    const store = openStore()
    messages.loadMessageWindow.mockResolvedValueOnce(null)
    expect(await store.jumpToMessage('gone', CH)).toBe(false)
    expect(seqs(store.messages)).toEqual(seqs(rows(280, 299)))
    expect(store.hasNewerMessages).toBe(false)
  })

  it('attaches at once when the rows around the target reach the newest message', async () => {
    const store = openStore()
    messages.loadMessageWindow.mockResolvedValueOnce({ messages: rows(265, 299), allOlderLoaded: false, hasNewer: false })
    await store.jumpToMessage('m270', CH)
    expect(store.hasNewerMessages).toBe(false)
    expect(seqs(store.messages)).toEqual(seqs(rows(265, 299)))
    expect(seqs(store.messageCache.get(CH)!.messages)).toEqual(seqs(rows(265, 299)))
  })

  it('keeps realtime rows past a detached list out of it, counts others, and caches them', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300, { user_id: 'other' }))
    store.addMessageToCache(row(301, { user_id: 'me' }))
    expect(seqs(store.messages)).toEqual(seqs(rows(15, 65)))
    expect(store.unseenWhileDetached).toBe(1)
    expect(seqs(store.messageCache.get(CH)!.messages)).toEqual(seqs(rows(280, 301)))
  })

  it('takes the pending row of a send into a detached list', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(302, { id: 'temp-1', user_id: 'me', sending: true }))
    expect(store.messages.at(-1)!.id).toBe('temp-1')
  })

  it('appends pages toward the present contiguously and attaches on the short one', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300, { user_id: 'other' }))
    const pages = [rows(66, 115), rows(116, 165), rows(166, 215), rows(216, 265), rows(266, 299)]
    for (const page of pages) messages.loadMessagesFrom.mockResolvedValueOnce({ messages: page, hasMore: page.length === NEWER_PAGE })

    for (let i = 0; i < pages.length; i++) {
      const cursor = store.messages.at(-1)!
      await store.fetchNewerMessages(CH)
      expect(messages.loadMessagesFrom).toHaveBeenLastCalledWith({ channelId: CH }, { from: cursor.created_at, limit: NEWER_PAGE })
      expect(store.hasNewerMessages).toBe(i < pages.length - 1)
    }

    // 15..299 without a gap, then the row realtime delivered while detached.
    expect(seqs(store.messages)).toEqual(seqs(rows(15, 300)))
    expect(store.unseenWhileDetached).toBe(0)
    expect(seqs(store.messageCache.get(CH)!.messages)).toEqual(seqs(rows(15, 300)))

    // Attached again: realtime rows append.
    store.addMessageToCache(row(301, { user_id: 'other' }))
    expect(store.messages.at(-1)!.id).toBe('m301')
    await store.fetchNewerMessages(CH)
    expect(messages.loadMessagesFrom).toHaveBeenCalledTimes(pages.length)
  })

  it('prepends older pages to a detached list without touching the cache', async () => {
    const store = await jumpedStore()
    messages.loadChannelMessages.mockResolvedValueOnce({ messages: rows(0, 14), hasMore: false })
    await store.fetchMessages(CH, 'm15')
    expect(seqs(store.messages)).toEqual(seqs(rows(0, 65)))
    expect(store.allMessagesLoaded).toBe(true)
    expect(seqs(store.messageCache.get(CH)!.messages)).toEqual(seqs(rows(280, 299)))
  })

  it('returns to the present with the newest page and what arrived while detached', async () => {
    const store = await jumpedStore()
    store.addMessageToCache(row(300, { user_id: 'other' }))
    messages.loadChannelMessages.mockResolvedValueOnce({ messages: rows(281, 300), hasMore: true })
    store.addMessageToCache(row(301, { user_id: 'other' }))
    await store.reloadNewestPage(CH)
    expect(store.hasNewerMessages).toBe(false)
    expect(store.unseenWhileDetached).toBe(0)
    expect(seqs(store.messages)).toEqual(seqs(rows(281, 301)))
  })

  it('discards a page toward the present that lands after the list was replaced', async () => {
    const store = await jumpedStore()
    const page = deferred<{ messages: any[]; hasMore: boolean }>()
    messages.loadMessagesFrom.mockReturnValueOnce(page.promise)
    const loading = store.fetchNewerMessages(CH)
    messages.loadChannelMessages.mockResolvedValueOnce({ messages: rows(280, 299), hasMore: true })
    await store.reloadNewestPage(CH)
    page.resolve({ messages: rows(66, 115), hasMore: true })
    await loading
    expect(seqs(store.messages)).toEqual(seqs(rows(280, 299)))
    expect(store.hasNewerMessages).toBe(false)
  })

  it('lands on the later of two jumps', async () => {
    const store = openStore()
    const first = deferred<any>()
    messages.loadMessageWindow.mockReturnValueOnce(first.promise)
    messages.loadMessageWindow.mockResolvedValueOnce({ messages: rows(100, 150), allOlderLoaded: false, hasNewer: true })
    const a = store.jumpToMessage('m40', CH)
    const b = store.jumpToMessage('m125', CH)
    expect(await b).toBe(true)
    first.resolve({ messages: rows(15, 65), allOlderLoaded: false, hasNewer: true })
    expect(await a).toBe(false)
    expect(seqs(store.messages)).toEqual(seqs(rows(100, 150)))
  })

  it('attaches when the channel opens from its cache', async () => {
    const store = await jumpedStore()
    store.loadCachedMessages(CH)
    expect(store.hasNewerMessages).toBe(false)
    expect(seqs(store.messages)).toEqual(seqs(rows(280, 299)))
  })
})
