/**
 * DMSidebar.vue in-call indicator: a conversation with a live call (a ring
 * silenced by mute included) says so and offers Join until the call ends.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const conversations = vi.hoisted(() => [
  { id: 'conv-muted', type: 'direct', is_muted: true, created_at: '2026-01-01', other_user: { id: 'a', username: 'a', is_local: true } },
  { id: 'conv-quiet', type: 'direct', is_muted: false, created_at: '2026-01-01', other_user: { id: 'b', username: 'b', is_local: true } },
])

vi.mock('@/stores/useDM', () => ({
  useDMStore: () => ({
    getSortedConversations: conversations,
    conversations,
    loadingConversations: false,
    isInitializing: false,
    currentConversationId: null,
    searchResults: [],
    isSearching: false,
    hideConversation: vi.fn(),
    prefetchConversationMessages: vi.fn(),
    loadConversationUserProfile: vi.fn(async () => false),
  }),
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ blockedUsers: new Set(), isBlocked: () => false }) }))
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return {
    useUserData: () => ({
      getUserDisplayName: () => ref('Someone'),
      getUserAvatarUrl: () => ref(''),
      getCurrentUser: ref({ id: 'me' }),
      subscribeToDMPresence: vi.fn(),
      getPresenceAwareStatus: () => ref('online'),
    }),
  }
})
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

const voice = vi.hoisted(() => ({ isConnectedOrJoining: false, effectiveChannelId: null as string | null }))
vi.mock('@/stores/unifiedVoiceChannel', async () => {
  const { reactive } = await import('vue')
  const store = reactive(voice)
  return { useUnifiedVoiceChannelStore: () => store }
})
vi.mock('@/composables/useCallSwitch', () => ({
  dmConversationIdFromChannel: (channelId: string | null) => (channelId?.startsWith('dm-') ? channelId.slice(3) : null),
}))
const joinConversationCall = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useDMCallJoin', () => ({ useDMCallJoin: () => ({ joinConversationCall }) }))

const stub = vi.hoisted(() => (name: string) => ({ default: { name, render: () => null } }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/GroupIcon.vue', () => stub('GroupIcon'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('@/components/dm/GroupChatInviteModal.vue', () => stub('GroupChatInviteModal'))

import DMSidebar from '../DMSidebar.vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

let wrapper: VueWrapper | null = null
const mountSidebar = () => {
  wrapper = shallowMount(DMSidebar, { global: { mocks: { $t: (key: string) => key } } })
  return wrapper
}
const row = (w: VueWrapper, id: string) =>
  w.findAll('[data-testid="dm-conversation-item"]')[conversations.findIndex((c) => c.id === id)]

beforeEach(() => {
  dmCallSignaling.cleanup()
  joinConversationCall.mockClear()
  const store = useUnifiedVoiceChannelStore() as any
  store.isConnectedOrJoining = false
  store.effectiveChannelId = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  dmCallSignaling.cleanup()
})

describe('DMSidebar in-call indicator', () => {
  it('marks a conversation with a live call, muted rows included, until the call ends', async () => {
    const w = mountSidebar()
    expect(w.find('[data-testid="dm-conversation-call"]').exists()).toBe(false)

    dmCallSignaling.registerRemoteCall('conv-muted', 'a', 'voice')
    await nextTick()

    const muted = row(w, 'conv-muted')
    expect(muted.classes()).toEqual(expect.arrayContaining(['muted', 'in-call']))
    expect(muted.find('[data-testid="dm-conversation-call"]').text()).toContain('dm.callInProgress')
    expect(muted.find('[data-testid="dm-conversation-join-call"]').exists()).toBe(true)
    expect(row(w, 'conv-quiet').classes()).not.toContain('in-call')

    dmCallSignaling.handleRemoteSignal({ type: 'timeout', callerId: 'a', callType: 'voice', timestamp: 1, conversationId: 'conv-muted' })
    await nextTick()
    expect(w.find('[data-testid="dm-conversation-call"]').exists()).toBe(false)
    expect(row(w, 'conv-muted').classes()).not.toContain('in-call')
  })

  it('Join opens the conversation and joins its call', async () => {
    const w = mountSidebar()
    dmCallSignaling.registerRemoteCall('conv-muted', 'a', 'voice')
    await nextTick()

    await row(w, 'conv-muted').find('[data-testid="dm-conversation-join-call"]').trigger('click')
    expect(w.emitted('conversationSelected')).toEqual([['conv-muted']])
    expect(joinConversationCall).toHaveBeenCalledWith('conv-muted')
  })

  it('offers no Join for the call this client is in', async () => {
    const store = useUnifiedVoiceChannelStore() as any
    store.isConnectedOrJoining = true
    store.effectiveChannelId = 'dm-conv-muted'
    const w = mountSidebar()
    dmCallSignaling.registerRemoteCall('conv-muted', 'a', 'voice')
    await nextTick()

    expect(row(w, 'conv-muted').find('[data-testid="dm-conversation-call"]').exists()).toBe(true)
    expect(row(w, 'conv-muted').find('[data-testid="dm-conversation-join-call"]').exists()).toBe(false)
  })
})
