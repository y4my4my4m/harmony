/**
 * Read markers of the message list. Messages scrolled into view queue a read of their
 * channel or conversation; the component is reused across contexts, so ids seen in one
 * must not suppress reads when it shows that context again. Opening a channel with
 * unread state reads it. A thread view carries its parent's channel id and sends no
 * channel reads: thread replies do not count toward the channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { Message } from '@/types'

const shared = vi.hoisted(() => ({
  outbox: { has: (_id: string) => false, discard: (_id: string) => {} },
  quickReactEnabled: true,
  unread: null as null | { unread_messages: number; unread_mentions: number },
  channelMentions: 0,
}))
const reads = vi.hoisted(() => ({ markChannelRead: vi.fn(async () => {}), markConversationRead: vi.fn(async () => {}) }))

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
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => loose({ notifications: [], unreadChannelMentions: () => shared.channelMentions }),
}))
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
vi.mock('@/composables/useUnreadCounts', () => ({ useUnreadCounts: () => ({ getUnreadCount: () => shared.unread }) }))
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
vi.mock('@/services/readState', () => reads)
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: async () => ({ isAuthenticated: true, profileId: 'me' }) },
}))
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

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed = new Set<Element>()
  constructor(public callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) { this.observed.add(el) }
  unobserve(el: Element) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  takeRecords() { return [] }
}

/** Reports the rendered row of `messageId` as scrolled into view. */
function intersect(messageId: string) {
  for (const io of FakeIntersectionObserver.instances) {
    for (const el of io.observed) {
      if (el.isConnected && el.getAttribute('data-message-id') === messageId) {
        io.callback([{ isIntersecting: true, target: el }])
      }
    }
  }
}

// The read queue sends 500 ms after the last read queued.
const afterDebounce = () => new Promise(resolve => setTimeout(resolve, 650))

const msg = (id: string, channelId: string, minute: number, extra: Partial<Message> = {}): Message => ({
  id,
  created_at: new Date(Date.UTC(2026, 9, 1, 12, minute)),
  channel_id: channelId,
  user_id: 'other',
  content: [{ type: 'text', text: id }],
  ...extra,
})

const chan1 = [msg('m1', 'chan-1', 1), msg('m2', 'chan-1', 2)]
const chan2 = [msg('n1', 'chan-2', 3)]

const mountDisplay = (props: Record<string, unknown>) => shallowMount(MessageDisplay, {
  attachTo: document.body,
  props: { currentUserId: 'me', ...props },
  global: { mocks: { $t: (key: string) => key } },
})

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  reads.markChannelRead.mockClear()
  reads.markConversationRead.mockClear()
  shared.unread = null
  shared.channelMentions = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('MessageDisplay read markers', () => {
  it('reads a channel again when it is shown again after another', async () => {
    const wrapper = mountDisplay({ messages: chan1, channelId: 'chan-1' })
    await flushPromises()
    intersect('m2')
    await afterDebounce()
    expect(reads.markChannelRead.mock.calls).toEqual([['chan-1', 'm2']])

    await wrapper.setProps({ messages: chan2, channelId: 'chan-2' })
    await flushPromises()
    await wrapper.setProps({ messages: chan1, channelId: 'chan-1' })
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 150))
    intersect('m2')
    await afterDebounce()

    expect(reads.markChannelRead.mock.calls).toEqual([['chan-1', 'm2'], ['chan-1', 'm2']])
    wrapper.unmount()
  })

  it('reads a channel with unread messages on open, without a row coming into view', async () => {
    shared.unread = { unread_messages: 3, unread_mentions: 0 }
    const wrapper = mountDisplay({ messages: chan1, channelId: 'chan-1' })
    await flushPromises()
    await afterDebounce()
    expect(reads.markChannelRead.mock.calls).toEqual([['chan-1', 'm2']])
    wrapper.unmount()
  })

  it('reads a channel with only an unread mention notification on open', async () => {
    shared.channelMentions = 1
    const wrapper = mountDisplay({ messages: chan1, channelId: 'chan-1' })
    await flushPromises()
    await afterDebounce()
    expect(reads.markChannelRead.mock.calls).toEqual([['chan-1', 'm2']])
    wrapper.unmount()
  })

  it('does not read a channel with nothing unread on open', async () => {
    const wrapper = mountDisplay({ messages: chan1, channelId: 'chan-1' })
    await flushPromises()
    await afterDebounce()
    expect(reads.markChannelRead).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends no channel read from a thread view', async () => {
    shared.unread = { unread_messages: 3, unread_mentions: 1 }
    const replies = [msg('r1', 'chan-1', 4, { thread_id: 't1' }), msg('r2', 'chan-1', 5, { thread_id: 't1' })]
    const wrapper = mountDisplay({ messages: replies, channelId: 'chan-1', threadId: 't1', enableReadDivider: false })
    await flushPromises()
    intersect('r2')
    await afterDebounce()
    expect(reads.markChannelRead).not.toHaveBeenCalled()
    expect(reads.markConversationRead).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
