/**
 * A bot reply to a slash command carries metadata.interaction: a line above it names the member
 * who used the command, and the name opens their profile. An invoker missing from the user cache
 * reads "Someone". Follow-ups carry the line too, and the reply always shows its header.
 * A bot the bots table hides is named from get_bot_profile; a bot neither returns is looked up once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { Message } from '@/types'

const users = vi.hoisted(() => ({
  'a1111111-1111-4111-8111-111111111111': { id: 'a1111111-1111-4111-8111-111111111111', displayName: 'Alice', username: 'alice', isLocal: true, domain: 'home.test' },
} as Record<string, { id: string; displayName: string; username: string; isLocal: boolean; domain: string }>))

const fetchUserProfile = vi.hoisted(() => vi.fn(async (id: string) => ({ id, username: id })))

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

const botLookups = vi.hoisted(() => vi.fn())
const fetchBotProfile = vi.hoisted(() => vi.fn(async (_id: string): Promise<object | null> => null))

// Answers the bot lookup of a bot row. Every other call resolves to no data.
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
    eq: (_column: string, id: string) => ({
      maybeSingle: async () => {
        botLookups(id)
        return { data: bots[id] ?? null, error: null }
      },
    }),
  }
  return { supabase: new Proxy({}, { get: (_t, key) => key === 'from' ? (table: string) => (table === 'bots' ? botQuery : empty()) : empty() }) }
})
vi.mock('@/services/botProfileService', () => ({ fetchBotProfile }))
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
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn(async () => true) }) }))
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
    fetchUserProfile,
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

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 9, minutes))

const BOT_ID = 'bot-1'
const message = (id: string, minutes: number, extra: Partial<Message> = {}): Message => ({
  id,
  created_at: at(minutes),
  channel_id: 'chan-1',
  bot_id: BOT_ID,
  content: [{ type: 'text', text: `text of ${id}` }],
  metadata: {},
  ...extra,
} as Message)

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  botLookups.mockClear()
  fetchBotProfile.mockReset()
  fetchBotProfile.mockResolvedValue(null)
})

async function mountList(messages: Message[]) {
  wrapper = shallowMount(MessageDisplay, {
    props: { messages, currentUserId: 'me', channelId: 'chan-1' },
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const headerOf = (id: string) => wrapper!.find(`#message-${id} [data-testid="interaction-header"]`)

describe('MessageDisplay interaction header', () => {
  it('names the member who used the command above the reply', async () => {
    await mountList([
      message('m1', 0, { metadata: { interaction: { id: 'i1', name: 'weather', user_id: 'a1111111-1111-4111-8111-111111111111' } } }),
    ])
    const header = headerOf('m1')
    expect(header.exists()).toBe(true)
    expect(header.text().replace(/\s+/g, ' ')).toBe('Alice used /weather')
    expect(header.find('button.interaction-user').text()).toBe('Alice')
    expect(wrapper!.get('#message-m1').attributes('aria-labelledby')).toContain('msg-interaction-m1')
  })

  it('opens the invoker\'s profile from the name', async () => {
    await mountList([
      message('m1', 0, { metadata: { interaction: { id: 'i1', name: 'weather', user_id: 'a1111111-1111-4111-8111-111111111111' } } }),
    ])
    await headerOf('m1').get('button.interaction-user').trigger('click')
    await flushPromises()
    expect(fetchUserProfile).toHaveBeenCalledWith('a1111111-1111-4111-8111-111111111111')
  })

  it('reads Someone for an invoker missing from the cache', async () => {
    await mountList([
      message('m1', 0, { metadata: { interaction: { id: 'i1', name: 'bridge clone-server', user_id: 'a2222222-2222-4222-8222-222222222222' } } }),
    ])
    const header = headerOf('m1')
    expect(header.text()).toBe('Someone used /bridge clone-server')
    expect(header.find('button').exists()).toBe(false)
  })

  it('heads follow-ups too, and each reply shows its author header', async () => {
    await mountList([
      message('m1', 0, { metadata: { interaction: { id: 'i1', name: 'weather', user_id: 'a1111111-1111-4111-8111-111111111111' } } }),
      message('m2', 1, { metadata: { interaction: { id: 'i1', name: 'weather', user_id: 'a1111111-1111-4111-8111-111111111111', followup: true } } }),
      message('m3', 2),
    ])
    expect(headerOf('m2').text().replace(/\s+/g, ' ')).toBe('Alice used /weather')
    expect(wrapper!.find('#message-m2 .message-header').exists()).toBe(true)
    expect(headerOf('m3').exists()).toBe(false)
    expect(wrapper!.find('#message-m3 .message-header').exists()).toBe(false)
  })

  it('ends a channel list with the slash command lines', async () => {
    await mountList([message('m1', 0)])
    const end = wrapper!.find('[data-testid="message-list-end"]')
    expect(end.exists()).toBe(true)
    expect(end.findComponent({ name: 'BotInteractionNotice' }).props()).toMatchObject({ channelId: 'chan-1', threadId: null })
  })
})

describe('MessageDisplay bot author', () => {
  it('names a bot the bots table hides from its profile', async () => {
    fetchBotProfile.mockResolvedValue({ id: 'bot-private', username: 'weatherbot', displayName: 'Weatherbot', avatarUrl: '' })
    await mountList([message('m1', 0, { bot_id: 'bot-private' })])
    expect(fetchBotProfile).toHaveBeenCalledWith('bot-private')
    expect(wrapper!.get('#message-m1 .username-text').text()).toBe('Weatherbot')
  })

  it('looks up a bot neither source returns once, however often its rows render', async () => {
    await mountList([message('m1', 0, { bot_id: 'bot-gone' }), message('m2', 10, { bot_id: 'bot-gone' })])
    await flushPromises()
    expect(botLookups.mock.calls.filter(([id]) => id === 'bot-gone')).toHaveLength(1)
    expect(fetchBotProfile).toHaveBeenCalledTimes(1)
    expect(wrapper!.get('#message-m1 .username-text').text()).toBe('Bot-bot-gone')
  })
})
