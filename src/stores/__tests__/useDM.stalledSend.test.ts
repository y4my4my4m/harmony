/** DM sends with no answer fail their row, as channel sends do (useChat.stalledSend.test.ts). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadConversationMessages: vi.fn(),
  sendDMMessage: vi.fn(),
  findSentMessage: vi.fn(),
  deleteMessage: vi.fn(async () => {}),
}))

vi.mock('@/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn(), fetchMultipleMessageReactions: vi.fn() }),
  seedNoReactions: vi.fn(),
}))
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
import { resetSendOrder } from '@/stores/shared/sendOrder'
import { SEND_STALL_MS, resetStalledSends } from '@/stores/shared/stalledSends'

const CONV = 'conv-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const text = (content: any) => content[0].text as string

const held: Array<(id: string, createdAt: string) => void> = []

const shown = (store: ReturnType<typeof useDMStore>) =>
  store.currentDMMessages.map((m: any) => {
    if (String(m.id).startsWith('temp-')) return `${m.failed ? 'failed' : 'pending'}:${text(m.content)}`
    return `${m.id}:${text(m.content)}`
  })

async function openStore() {
  const store = useDMStore()
  store.currentConversationId = CONV
  messages.loadConversationMessages.mockResolvedValueOnce({
    messages: [{ id: 'old', conversation_id: CONV, user_id: 'them', content: [{ type: 'text', text: 'old' }], created_at: at(0) }],
    hasMore: false,
  })
  await store.fetchConversationMessages(CONV)
  return store
}

describe('a DM send with no answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    resetSendOrder()
    resetStalledSends()
    held.length = 0
    Object.values(messages).forEach(fn => fn.mockReset())
    messages.findSentMessage.mockResolvedValue(null)
    messages.deleteMessage.mockResolvedValue(undefined)
    messages.sendDMMessage.mockImplementation((conversationId: string, content: any, _r: any, _o: any, metadata: any) =>
      new Promise((resolve) => {
        held.push((id, createdAt) => resolve({ id, conversation_id: conversationId, user_id: 'me', content, created_at: createdAt, metadata }))
      }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails its row at the deadline; a late answer turns it into the stored message', async () => {
    const store = await openStore()
    const send = store.sendDMMessage(CONV, 'me', [{ type: 'text', text: 'hung' }] as any)
    await vi.advanceTimersByTimeAsync(SEND_STALL_MS)
    await expect(send).resolves.toBe(false)
    expect(shown(store)).toEqual(['old:old', 'failed:hung'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(messages.sendDMMessage).toHaveBeenCalledTimes(1)

    held[0]('stored', at(5))
    await vi.waitFor(() => expect(shown(store)).toEqual(['old:old', 'stored:hung']))
  })

  it('Retry looks the row up by its nonce before sending again', async () => {
    const store = await openStore()
    const send = store.sendDMMessage(CONV, 'me', [{ type: 'text', text: 'hung' }] as any)
    await vi.advanceTimersByTimeAsync(SEND_STALL_MS)
    await send
    const row = store.currentDMMessages[1] as any
    const retry = store.retryDMMessage(row.id, CONV, 'me', row.content)
    await vi.waitFor(() => expect(held).toHaveLength(2))
    expect(messages.findSentMessage).toHaveBeenCalledWith({ conversationId: CONV }, 'me', row.metadata.client_nonce)
    held[1]('second', at(6))
    await retry
    expect(shown(store)).toEqual(['old:old', 'second:hung'])

    held[0]('first', at(5))
    await vi.waitFor(() => expect(messages.deleteMessage).toHaveBeenCalledWith('first'))
    expect(shown(store)).toEqual(['old:old', 'second:hung'])
  })

  async function stalledRow(store: Awaited<ReturnType<typeof openStore>>) {
    const send = store.sendDMMessage(CONV, 'me', [{ type: 'text', text: 'hung' }] as any)
    await vi.advanceTimersByTimeAsync(SEND_STALL_MS)
    await send
    const row = store.currentDMMessages[1] as any
    store.discardFailedDMMessage(row.id)
    return row
  }

  it('an outbox re-send whose lookup fails leaves the row failed, sending nothing', async () => {
    const store = await openStore()
    const row = await stalledRow(store)
    messages.findSentMessage.mockRejectedValueOnce(new Error('fetch failed'))
    const resend = store.sendDMMessage(CONV, 'me', row.content, undefined, { tempId: row.id, clientNonce: row.metadata.client_nonce })
    await vi.advanceTimersByTimeAsync(10_000 + 2 * SEND_STALL_MS)
    await expect(resend).resolves.toBe(false)
    expect(messages.sendDMMessage).toHaveBeenCalledTimes(1)
    expect(shown(store)).toEqual(['old:old', 'failed:hung'])
  })

  it('an automatic retry of a stalled row looks it up first and keeps a message stored meanwhile', async () => {
    const store = await openStore()
    const row = await stalledRow(store)
    messages.sendDMMessage.mockRejectedValueOnce(new Error('502'))
    messages.findSentMessage.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'stored', conversation_id: CONV, user_id: 'me', content: row.content, created_at: at(5), metadata: row.metadata,
    })
    const resend = store.sendDMMessage(CONV, 'me', row.content, undefined, { tempId: row.id, clientNonce: row.metadata.client_nonce })
    await vi.advanceTimersByTimeAsync(10_000 + SEND_STALL_MS)
    await expect(resend).resolves.toBe(true)
    expect(messages.findSentMessage).toHaveBeenCalledTimes(2)
    expect(messages.sendDMMessage).toHaveBeenCalledTimes(2)
    expect(shown(store)).toEqual(['old:old', 'stored:hung'])
  })
})
