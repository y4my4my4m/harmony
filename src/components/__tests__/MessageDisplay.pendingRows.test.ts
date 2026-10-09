/**
 * A row with no persisted message (temp- id: an optimistic copy or an outbox row)
 * offers no action that acts on the message id: no context menu, no quick react.
 * Delete on a failed outbox row discards the outbox job.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { Message } from '@/types'

const shared = vi.hoisted(() => ({
  outbox: { has: (_id: string) => false, discard: (_id: string) => {} },
  quickReactEnabled: true,
}))

/** A store double: named fields as given, any other member an async no-op. */
function loose<T extends object>(fields: T): T {
  return new Proxy(fields, {
    get(target, key) {
      if (key in target) return (target as Record<PropertyKey, unknown>)[key]
      if (typeof key === 'symbol' || key === 'then') return undefined
      const fn = vi.fn(async () => undefined)
      ;(target as Record<PropertyKey, unknown>)[key] = fn
      return fn
    },
  })
}

vi.mock('@/stores/useOutbox', () => ({ useOutboxStore: () => shared.outbox }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => loose({}) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => loose({ currentServerId: null, currentServer: null, channels: [], servers: [] }),
}))
vi.mock('@/stores/useServerRoles', () => ({ useServerRolesStore: () => loose({ getUserRoleColor: () => null }) }))
vi.mock('@/stores/useChat', () => ({
  useChatStore: () => loose({ messageGaps: new Set(), allMessagesLoaded: true, loadingOlderMessages: false }),
}))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => loose({ allMessagesLoaded: true }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => loose({ session: { user: { id: 'auth-1' } } }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => loose({ profile: { id: 'me' }, profileId: 'me' }) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => loose({}) }))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => loose({ blockedUsers: new Set(), isBlocked: () => false }),
}))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => loose({ getMessageReactions: () => [] }) }))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => loose({}) }))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => loose({ threadForMessage: () => null, threadsForChannel: () => [] }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ isCurrentUserServerOwner: ref(false), canManageMessages: ref(false) }),
}))
vi.mock('@/composables/useUserData', () => ({
  DEFAULT_USER_COLOR: '#fff',
  useUserData: () => ({
    getUserDisplayName: () => ref('me'),
    getUserColor: () => ref('#fff'),
    getUserAvatarUrl: () => ref(''),
    ensureProfilesAvailable: vi.fn(async () => {}),
    fetchUserProfile: vi.fn(async () => null),
    getUserProfile: () => ref(null),
  }),
}))
vi.mock('@/composables/useHapticSettings', () => ({
  useHapticSettings: () => ({ triggerInteraction: vi.fn(), triggerDestructive: vi.fn() }),
}))
vi.mock('@/composables/useQuickReactSettings', () => ({
  useQuickReactSettings: () => ({
    enabled: computed(() => shared.quickReactEnabled),
    emoji: ref({ id: 'thumbs', name: 'thumbs', url: '', content: '👍' }),
  }),
}))
vi.mock('@/composables/useLayoutState', () => ({ useLayoutState: () => ({ isMobile: ref(false) }) }))
vi.mock('@/composables/useUnreadCounts', () => ({ useUnreadCounts: () => ({ getUnreadCount: () => null }) }))
vi.mock('@/composables/useReadDivider', () => ({
  useReadDivider: () => ({
    dividerBeforeMessageId: ref(null),
    captureBoundary: vi.fn(),
    resolveDivider: vi.fn(() => null),
    clear: vi.fn(),
  }),
}))
vi.mock('@/composables/useFloatingVideo', () => ({
  floatingReturnTarget: () => null,
  useFloatingVideo: () => ({ floatingMessageId: ref(null) }),
}))
vi.mock('@/services/readState', () => ({ markChannelRead: vi.fn(), markConversationRead: vi.fn() }))
vi.mock('@/services/FundingService', () => ({ fundingService: loose({}) }))
vi.mock('@/services/AutoModService', () => ({ isModerationRejectionCode: () => false }))
vi.mock('@/utils/unifiedContentProcessing', () => ({
  parseContentToMessageParts: vi.fn(),
  resolveMentionsUserData: vi.fn(),
  resolveEmojisData: vi.fn(),
  resolveRoleMentionsData: vi.fn(),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed: vueComputed, unref } = await import('vue')
  return {
    defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
      Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, i) => range.startIndex + i),
    useVirtualizer: (options: unknown) => vueComputed(() => {
      const opts = unref(options as { value: { count: number; getItemKey: (i: number) => unknown } })
      return {
        getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
          index, key: opts.getItemKey(index), start: index * 60, size: 60, end: (index + 1) * 60,
        })),
        getTotalSize: () => opts.count * 60,
        measureElement: () => {},
        scrollToIndex: () => {},
        scrollToOffset: () => {},
        isScrolling: false,
      }
    }),
  }
})

import MessageDisplay from '../MessageDisplay.vue'

const pendingRow = (overrides: Partial<Message> = {}): Message => ({
  id: 'temp-1-abc',
  created_at: new Date(),
  channel_id: 'chan-1',
  user_id: 'me',
  content: [{ type: 'text', text: 'pending' }],
  metadata: { client_nonce: 'nonce-1' },
  sending: true,
  ...overrides,
})

const mountDisplay = (messages: Message[]) => shallowMount(MessageDisplay, {
  props: { messages, currentUserId: 'me', channelId: 'chan-1' },
  global: { mocks: { $t: (key: string) => key } },
})

beforeEach(() => {
  shared.outbox = { has: () => false, discard: vi.fn() }
  shared.quickReactEnabled = true
})

describe('MessageDisplay rows with no persisted message', () => {
  it('opens no context menu on right-click', async () => {
    const wrapper = mountDisplay([pendingRow()])
    await flushPromises()
    await wrapper.get('.message-item').trigger('contextmenu', { clientX: 5, clientY: 5 })
    expect(wrapper.findComponent({ name: 'MessageContextMenu' }).props('isVisible')).toBe(false)
  })

  it('opens the context menu on a persisted message', async () => {
    const wrapper = mountDisplay([pendingRow({ id: 'msg-1', sending: false })])
    await flushPromises()
    await wrapper.get('.message-item').trigger('contextmenu', { clientX: 5, clientY: 5 })
    expect(wrapper.findComponent({ name: 'MessageContextMenu' }).props('isVisible')).toBe(true)
  })

  it('sends no quick reaction on a double tap', async () => {
    const wrapper = mountDisplay([pendingRow()])
    await flushPromises()
    const row = wrapper.get('.message-item')
    await row.trigger('touchend')
    await row.trigger('touchend')
    expect(wrapper.emitted('sendReaction')).toBeUndefined()

    const persisted = mountDisplay([pendingRow({ id: 'msg-2', sending: false })])
    await flushPromises()
    const persistedRow = persisted.get('.message-item')
    await persistedRow.trigger('touchend')
    await persistedRow.trigger('touchend')
    expect(persisted.emitted('sendReaction')?.[0]?.[0]).toBe('msg-2')
  })

  it('offers a failed outbox row Retry and Delete only, Delete discarding through the parent', async () => {
    shared.outbox = { has: (id) => id === 'temp-1-abc', discard: vi.fn() }
    const wrapper = mountDisplay([pendingRow({ sending: false, failed: true })])
    await flushPromises()
    const row = wrapper.get('.message-item')
    await row.trigger('mouseover')
    expect(wrapper.find('.message-actions').exists()).toBe(false)

    await wrapper.get('.failed-message-bar .discard-btn').trigger('click')
    expect(wrapper.emitted('discard-message')?.[0]?.[0]).toMatchObject({ id: 'temp-1-abc' })
  })

  it('shows the action bar on a persisted message', async () => {
    const wrapper = mountDisplay([pendingRow({ id: 'msg-3', sending: false })])
    await flushPromises()
    await wrapper.get('.message-item').trigger('mouseover')
    expect(wrapper.find('.message-actions').exists()).toBe(true)
  })
})
