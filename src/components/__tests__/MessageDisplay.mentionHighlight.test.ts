/**
 * A channel message that names the viewer is highlighted: a mention of their profile, a role
 * they hold, @everyone (the default role, which every member holds) or @here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { Message } from '@/types'

const shared = vi.hoisted(() => ({
  outbox: { has: (_id: string) => false, discard: (_id: string) => {} },
  quickReactEnabled: true,
  roles: [] as Array<{ id: string }>,
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
  useServerPermissions: () => ({
    isCurrentUserServerOwner: ref(false),
    canManageMessages: ref(false),
    getCurrentUserRole: computed(() => ({ roles: shared.roles })),
  }),
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

const EVERYONE = '00000000-0000-4000-8000-0000000000e0'
const CREW = '00000000-0000-4000-8000-0000000000c0'

const message = (id: string, content: unknown[]): Message => ({
  id,
  created_at: new Date(),
  channel_id: 'chan-1',
  user_id: 'someone',
  content,
  metadata: {},
} as Message)

const highlighted = async (props: Record<string, unknown>, content: unknown[]) => {
  const wrapper = shallowMount(MessageDisplay, {
    props: { messages: [message('m1', content)], currentUserId: 'me', ...props },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper.get('.message-item').classes().includes('mentions-me')
}

const inChannel = (content: unknown[]) => highlighted({ channelId: 'chan-1' }, content)

beforeEach(() => {
  shared.roles = [{ id: EVERYONE }]
})

describe('MessageDisplay mention highlight', () => {
  it('highlights @here', async () => {
    expect(await inChannel([{ type: 'text', text: 'standup ' },
      { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null }])).toBe(true)
  })

  it('highlights @everyone and a mention of the viewer', async () => {
    expect(await inChannel([{ type: 'role_mention', roleId: EVERYONE, roleName: 'everyone', roleColor: null }])).toBe(true)
    expect(await inChannel([{ type: 'mention', userId: 'me', username: 'me', domain: 'harmony.test', isLocal: true }])).toBe(true)
  })

  it('highlights a role only for its holders', async () => {
    const crew = [{ type: 'role_mention', roleId: CREW, roleName: 'crew', roleColor: null }]
    expect(await inChannel(crew)).toBe(false)
    shared.roles = [{ id: EVERYONE }, { id: CREW }]
    expect(await inChannel(crew)).toBe(true)
  })

  it('leaves other messages and conversations alone', async () => {
    expect(await inChannel([{ type: 'mention', userId: 'other', username: 'other', domain: 'harmony.test', isLocal: true }])).toBe(false)
    expect(await highlighted({ conversationId: 'conv-1' },
      [{ type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null }])).toBe(false)
  })
})
