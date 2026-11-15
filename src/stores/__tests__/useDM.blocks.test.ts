/**
 * A block between the two accounts of a direct conversation (20261111500001_dm_blocks.sql): a send
 * refused with DM_UNDELIVERABLE is not retried, and a refused new conversation tells the blocker to
 * unblock instead of naming the recipient's setting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const messages = vi.hoisted(() => ({
  loadConversationMessages: vi.fn(),
  sendDMMessage: vi.fn(),
  findSentMessage: vi.fn(),
  deleteMessage: vi.fn(async () => {}),
}))
const rpc = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
const blocked = vi.hoisted(() => new Set<string>())

vi.mock('@/supabase', () => ({ supabase: { from: vi.fn(), rpc, removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ isBlocked: (id: string) => blocked.has(id) }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError }) }))
vi.mock('@/i18n', () => ({
  i18n: { global: { t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}` } },
}))
vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn(), fetchMultipleMessageReactions: vi.fn() }),
  seedNoReactions: vi.fn(),
}))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: () => ({ id: 'me' }),
    getUser: (id: string) => (id === 'them' ? { id, username: 'them', displayName: 'Them' } : null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
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
import { resetStalledSends } from '@/stores/shared/stalledSends'

const CONV = 'conv-1'
const refusal = (message: string) => ({ code: 'P0001', message, hint: 'This person limits who can start a conversation with them.' })

async function openStore() {
  const store = useDMStore()
  store.currentConversationId = CONV
  messages.loadConversationMessages.mockResolvedValueOnce({
    messages: [{ id: 'old', conversation_id: CONV, user_id: 'them', content: [{ type: 'text', text: 'old' }], created_at: '2026-10-01T00:00:00Z' }],
    hasMore: false,
  })
  await store.fetchConversationMessages(CONV)
  return store
}

describe('DMs across a block', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    resetSendOrder()
    resetStalledSends()
    blocked.clear()
    toastError.mockReset()
    rpc.mockReset()
    Object.values(messages).forEach(fn => fn.mockReset())
    messages.findSentMessage.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops an undeliverable send once, without retrying', async () => {
    const store = await openStore()
    store.conversations = [{ id: CONV, created_at: '2026-10-01T00:00:00Z', type: 'direct' }] as any
    messages.sendDMMessage.mockRejectedValue({ code: 'DM_UNDELIVERABLE', message: 'Your message could not be delivered.' })

    await expect(store.sendDMMessage(CONV, 'me', [{ type: 'text', text: 'hi' }] as any))
      .rejects.toMatchObject({ code: 'DM_UNDELIVERABLE' })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(messages.sendDMMessage).toHaveBeenCalledTimes(1)
    expect(store.currentDMMessages.map((m: any) => m.id)).toEqual(['old'])
    expect(store.conversations[0].last_message?.id).toBe('old')
  })

  it('tells the blocker to unblock when a new conversation is refused', async () => {
    const store = useDMStore()
    blocked.add('them')
    rpc.mockResolvedValue({ data: null, error: refusal('DM_NOT_ALLOWED') })

    await expect(store.createOrGetConversation('me', 'them')).resolves.toBeNull()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0][0]).toBe('dm.blockedPeer.startRefused{"name":"Them"}')
  })

  it('names the recipient\'s setting to anyone else', async () => {
    const store = useDMStore()
    rpc.mockResolvedValue({ data: null, error: refusal('DM_NOT_ALLOWED') })

    await expect(store.createOrGetConversation('me', 'them')).resolves.toBeNull()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0][0]).toBe('automod.antispam.dmNotAllowed{}')
  })
})
