/** DM sends leave one at a time, as channel sends do (useChat.sendOrder.test.ts). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadConversationMessages: vi.fn(),
  sendDMMessage: vi.fn(),
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

const CONV = 'conv-1'
const T0 = Date.parse('2026-10-01T00:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const text = (content: any) => content[0].text as string
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const held: Array<{ text: string; answer: (createdAt: string) => void }> = []

const shown = (store: ReturnType<typeof useDMStore>) =>
  store.currentDMMessages.map((m: any) => (String(m.id).startsWith('temp-') ? `pending:${text(m.content)}` : text(m.content)))

describe('DM sends in order', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetSendOrder()
    held.length = 0
    Object.values(messages).forEach(fn => fn.mockReset())
    messages.sendDMMessage.mockImplementation((conversationId: string, content: any, _r: any, _o: any, metadata: any) =>
      new Promise((resolve) => {
        held.push({
          text: text(content),
          answer: (createdAt) => resolve({
            id: `id-${text(content)}`, conversation_id: conversationId, user_id: 'me', content, created_at: createdAt, metadata,
          }),
        })
      }))
  })

  it('starts one insert at a time and ends in server order', async () => {
    const store = useDMStore()
    store.currentConversationId = CONV
    messages.loadConversationMessages.mockResolvedValueOnce({
      messages: [{ id: 'old', conversation_id: CONV, user_id: 'them', content: [{ type: 'text', text: 'old' }], created_at: at(0) }],
      hasMore: false,
    })
    await store.fetchConversationMessages(CONV)

    const sends = ['1', '2', '3'].map((t) => store.sendDMMessage(CONV, 'me', [{ type: 'text', text: t }] as any))
    await tick()
    expect(shown(store)).toEqual(['old', 'pending:1', 'pending:2', 'pending:3'])
    expect(held.map((h) => h.text)).toEqual(['1'])

    held[0].answer(at(10))
    await tick()
    held[1].answer(at(11))
    await tick()
    held[2].answer(at(12))
    await Promise.all(sends)
    expect(held.map((h) => h.text)).toEqual(['1', '2', '3'])
    expect(shown(store)).toEqual(['old', '1', '2', '3'])
  })
})
