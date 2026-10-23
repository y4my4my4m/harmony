/**
 * The author line of a chat message from a user on another instance carries the
 * federated globe, named after that instance. Local users, bots and Discord-bridged
 * authors do not; a bridged author keeps the Discord badge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { Message } from '@/types'

const users = vi.hoisted(() => ({
  'remote-1': { id: 'remote-1', displayName: 'spartzy', isLocal: false, domain: 'spacify.cloud' },
  'local-1': { id: 'local-1', displayName: 'localperson', isLocal: true, domain: 'home.test' },
} as Record<string, { id: string; displayName: string; isLocal: boolean; domain: string }>))

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

// Answers the bot lookup of a bot row; an unanswered lookup re-renders the row without end.
// Every other call resolves to no data.
vi.mock('@/supabase', () => {
  const bots: Record<string, object> = { 'bot-1': { id: 'bot-1', username: 'botty', display_name: 'Botty', avatar_url: '' } }
  const empty = (): unknown => new Proxy(function () {}, {
    get: (_t, key) => key === 'then'
      ? (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve)
      : empty(),
    apply: () => empty(),
  })
  const botQuery = {
    select: () => botQuery,
    eq: (_column: string, id: string) => ({ single: async () => ({ data: bots[id] ?? null, error: null }) }),
  }
  return { supabase: new Proxy({}, { get: (_t, key) => key === 'from' ? (table: string) => (table === 'bots' ? botQuery : empty()) : empty() }) }
})
vi.mock('@/composables/useT', async () => {
  const { createI18n } = await import('vue-i18n')
  const en = (await import('@/locales/en.json')).default
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return { useT: () => ({ t: i18n.global.t, locale: i18n.global.locale }) }
})
vi.mock('@/stores/useOutbox', () => ({ useOutboxStore: () => ({ has: () => false, discard: () => {} }) }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => loose({}) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => loose({ currentServerId: null, currentServer: null, channels: [], servers: [] }),
}))
vi.mock('@/stores/useServerRoles', () => ({ useServerRolesStore: () => loose({ getUserRoleColor: () => null }) }))
vi.mock('@/stores/useChat', () => ({
  useChatStore: () => loose({ hasNewerMessages: false, allMessagesLoaded: true, loadingOlderMessages: false }),
}))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => loose({ allMessagesLoaded: true, hasNewerMessages: false }) }))
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
    getCurrentUserRole: computed(() => ({ roles: [] })),
  }),
}))
vi.mock('@/composables/useUserData', () => ({
  DEFAULT_USER_COLOR: '#fff',
  useUserData: () => ({
    getUser: (id: string) => computed(() => users[id]),
    getUserDisplayName: (id: string) => computed(() => users[id]?.displayName ?? id),
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
    doubleClick: computed(() => true),
    doubleTap: computed(() => true),
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

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 9, minutes))

const message = (id: string, minutes: number, extra: Partial<Message> = {}): Message => ({
  id,
  created_at: at(minutes),
  channel_id: 'chan-1',
  user_id: 'local-1',
  content: [{ type: 'text', text: `text of ${id}` }],
  metadata: {},
  ...extra,
} as Message)

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function mountList(messages: Message[], props: Record<string, unknown> = { channelId: 'chan-1' }) {
  wrapper = shallowMount(MessageDisplay, {
    props: { messages, currentUserId: 'me', ...props },
    global: { mocks: { $t: (key: string) => key }, stubs: { FederatedUserBadge: false } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const globeIn = (id: string) => wrapper!.get(`#message-${id} .message-meta .username`).find('[data-testid="federated-user-badge"]')

describe('MessageDisplay federated author', () => {
  it('puts a globe named after the instance after a remote author\'s name', async () => {
    await mountList([message('m1', 0, { user_id: 'remote-1' })])
    const globe = globeIn('m1')
    expect(globe.exists()).toBe(true)
    expect(globe.attributes('role')).toBe('img')
    expect(globe.attributes('aria-label')).toBe('From spacify.cloud')
    expect(globe.element.previousElementSibling?.classList.contains('username-text')).toBe(true)
  })

  it('shows no globe for local users, bots, webhooks or Discord-bridged authors', async () => {
    await mountList([
      message('local', 0, { user_id: 'local-1' }),
      message('bot', 10, { user_id: null as never, bot_id: 'bot-1' }),
      message('hook', 20, { user_id: null as never, bot_id: 'bot-2', metadata: { webhook: { id: 'w1', name: 'Hook' } } }),
      // A bridged row whose user_id is a remote profile still shows only the Discord badge.
      message('bridged', 30, { user_id: 'remote-1', metadata: { discord_user: { id: 'd1', username: 'discorder' } } }),
    ])
    for (const id of ['local', 'bot', 'hook', 'bridged']) expect(globeIn(id).exists(), id).toBe(false)
    expect(wrapper!.get('#message-bridged .username').findComponent({ name: 'BridgeSourceBadge' }).exists()).toBe(true)
  })

  it('shows the globe in a direct message too', async () => {
    await mountList([message('d1', 0, { user_id: 'remote-1', channel_id: null as never, conversation_id: 'conv-1' })], { conversationId: 'conv-1' })
    expect(globeIn('d1').attributes('aria-label')).toBe('From spacify.cloud')
  })
})
