/**
 * The message list for screen-reader and keyboard users: a labelled list of
 * articles named author, content, time and state, one tab stop, arrow keys
 * between rows, Enter opening the message menu, and live announcements of
 * arrivals and failed sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import type { Message } from '@/types'
import { announcerRegions, resetAnnouncer } from '@/composables/useAnnouncer'
import { NEW_MESSAGE_BATCH_MS } from '@/composables/useNewMessageAnnouncer'

const shared = vi.hoisted(() => ({
  outbox: { has: (_id: string) => false, discard: (_id: string) => {} },
  quickReactEnabled: true,
  roles: [] as Array<{ id: string }>,
  divider: null as string | null,
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
    doubleClick: computed(() => shared.quickReactEnabled),
    doubleTap: computed(() => shared.quickReactEnabled),
    emoji: ref({ id: 'thumbs', name: 'thumbs', url: '', content: '👍' }),
  }),
}))
vi.mock('@/composables/useLayoutState', () => ({ useLayoutState: () => ({ isMobile: ref(false) }) }))
vi.mock('@/composables/useUnreadCounts', () => ({ useUnreadCounts: () => ({ getUnreadCount: () => null }) }))
vi.mock('@/composables/useReadDivider', () => ({
  useReadDivider: () => ({
    dividerBeforeMessageId: ref(shared.divider),
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

const { politeText, assertiveText } = announcerRegions()

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 9, minutes))

const message = (id: string, minutes: number, extra: Partial<Message> = {}): Message => ({
  id,
  created_at: at(minutes),
  channel_id: 'chan-1',
  user_id: 'someone',
  content: [{ type: 'text', text: `text of ${id}` }],
  metadata: {},
  ...extra,
} as Message)

let wrapper: VueWrapper | null = null

async function mountList(messages: Message[]) {
  wrapper = shallowMount(MessageDisplay, {
    props: { messages, currentUserId: 'me', channelId: 'chan-1' },
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const rows = () => wrapper!.findAll('[data-message-row]')
const press = async (el: Element, key: string, init: KeyboardEventInit = {}) => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  await nextTick()
}

beforeEach(() => {
  resetAnnouncer()
  shared.roles = []
  shared.divider = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  resetAnnouncer()
})

describe('MessageDisplay rows', () => {
  it('is a labelled list of articles, each named by its parts in order', async () => {
    await mountList([message('m1', 0), message('m2', 1), message('m3', 2, { user_id: 'me', updated_at: at(5) })])
    const list = wrapper!.get('[role="list"]')
    expect(list.attributes('aria-label')).toBe('messageA11y.list.generic')
    const items = wrapper!.findAll('[role="listitem"]')
    expect(items.map((i) => i.attributes('aria-posinset'))).toEqual(['1', '2', '3'])
    expect(items[0].attributes('aria-setsize')).toBe('3')

    const row = rows()[0]
    expect(row.attributes('role')).toBe('article')
    expect(row.attributes('aria-labelledby')).toBe('msg-head-m1 msg-body-m1 msg-meta-m1')
    expect(wrapper!.get('#msg-head-m1').text()).toBe('me')
    expect(wrapper!.get('#msg-meta-m1').text()).toMatch(/2026/)
    expect(wrapper!.get('#msg-meta-m3').text()).toContain('messageA11y.row.edited')
  })

  it('names a grouped row\'s author for browse mode only where no header shows it', async () => {
    await mountList([message('m1', 0), message('m2', 1)])
    expect(wrapper!.get('#msg-head-m1').attributes('aria-hidden')).toBe('true')
    expect(wrapper!.get('#msg-head-m2').attributes('aria-hidden')).toBeUndefined()
  })

  it('adds the reply reference to the name of a reply', async () => {
    await mountList([message('m1', 0), message('m2', 1, { reply_to: 'm1' })])
    expect(rows()[1].attributes('aria-labelledby')).toBe('msg-head-m2 msg-reply-m2 msg-body-m2 msg-meta-m2')
  })

  it('says when a message mentions the viewer', async () => {
    await mountList([message('m1', 0, { content: [{ type: 'mention', userId: 'me', username: 'me' }] as never })])
    expect(wrapper!.get('#msg-meta-m1').text()).toContain('messageA11y.row.mentionsYou')
  })

  it('marks a new day and the first unread message with headings', async () => {
    shared.divider = 'm2'
    await mountList([message('m1', 0), message('m2', 60 * 24 + 5)])
    const day = wrapper!.get('.date-separator')
    expect(day.attributes('role')).toBe('heading')
    expect(day.attributes('aria-level')).toBe('3')
    const unread = wrapper!.get('.new-messages-divider')
    expect(unread.attributes('role')).toBe('heading')
    expect(unread.get('.sr-only').text()).toBe('messageA11y.newMessagesDivider')
    expect(unread.get('.new-messages-label').attributes('aria-hidden')).toBe('true')
  })

  it('makes the newest row the single tab stop', async () => {
    await mountList([message('m1', 0), message('m2', 1), message('m3', 2)])
    expect(rows().map((r) => r.attributes('tabindex'))).toEqual(['-1', '-1', '0'])
  })
})

describe('MessageDisplay keyboard', () => {
  it('moves between rows with Up, Down, Home and End', async () => {
    await mountList([message('m1', 0), message('m2', 10), message('m3', 20)])
    const [first, second, third] = rows().map((r) => r.element as HTMLElement)
    third.focus()
    await press(third, 'ArrowUp')
    expect(document.activeElement).toBe(second)
    await press(second, 'Home')
    expect(document.activeElement).toBe(first)
    await press(first, 'End')
    expect(document.activeElement).toBe(third)
    await press(third, 'ArrowDown')
    expect(document.activeElement).toBe(third)
    await press(third, 'ArrowUp')
    await nextTick()
    expect(second.getAttribute('tabindex')).toBe('0')
    expect(third.getAttribute('tabindex')).toBe('-1')
  })

  it('leaves keys pressed inside a row to the control that has focus', async () => {
    await mountList([message('m1', 0), message('m2', 10)])
    const second = rows()[1].element as HTMLElement
    const inner = document.createElement('button')
    second.appendChild(inner)
    inner.focus()
    await press(inner, 'ArrowUp')
    expect(document.activeElement).toBe(inner)
  })

  it('opens the message menu on Enter, the ContextMenu key and Shift+F10, returning focus to the row', async () => {
    await mountList([message('m1', 0), message('m2', 10)])
    const row = rows()[1].element as HTMLElement
    const menu = () => wrapper!.findComponent({ name: 'MessageContextMenu' })
    for (const init of [{ key: 'Enter' }, { key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      row.focus()
      await press(row, init.key, init)
      expect(menu().props('isVisible')).toBe(true)
      expect(menu().props('message')).toMatchObject({ id: 'm2' })
      expect(menu().props('trigger')).toBe(row)
      menu().vm.$emit('close')
      await nextTick()
      expect(menu().props('isVisible')).toBe(false)
    }
  })
})

describe('MessageDisplay announcements', () => {
  it('speaks messages from others that arrive after the list settled, not its own', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(at(30))
    const messages = [message('m1', 0)]
    await mountList(messages)
    vi.setSystemTime(at(31))

    await wrapper!.setProps({ messages: [...messages, message('m2', 31, { user_id: 'me' })] })
    await flushPromises()
    vi.advanceTimersByTime(NEW_MESSAGE_BATCH_MS + 500)
    expect(politeText.value).toBe('')

    await wrapper!.setProps({ messages: [...messages, message('m2', 31, { user_id: 'me' }), message('m3', 32)] })
    await flushPromises()
    vi.advanceTimersByTime(NEW_MESSAGE_BATCH_MS + 500)
    expect(politeText.value).toBe('messageA11y.announce.one')
  })

  it('says a failed send assertively, once', async () => {
    const failed = message('temp-1', 1, { user_id: 'me', failed: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mountList([message('m1', 0)])
    await wrapper!.setProps({ messages: [message('m1', 0), failed] })
    await flushPromises()
    vi.advanceTimersByTime(500)
    expect(assertiveText.value).toBe('messageA11y.failed.announce')
    expect(wrapper!.get('#msg-meta-temp-1').text()).toContain('messageA11y.row.failed')
  })
})
