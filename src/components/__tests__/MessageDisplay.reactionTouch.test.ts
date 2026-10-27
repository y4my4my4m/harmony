/**
 * Touches on a reaction pill belong to the pill: a long-press or double tap
 * there neither opens the message's action bar nor sends a quick reaction.
 * Double tap and double-click each react only under their own switch; the
 * dblclick a browser sends after a double tap is not a double-click.
 * The message long-press tolerates finger jitter and cancels on a drag or a
 * touchcancel. The pill's info card (All reactions) and the context menu's View
 * reactions open the one reactions list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import type { Message } from '@/types'

const shared = vi.hoisted(() => ({
  outbox: { has: (_id: string) => false, discard: (_id: string) => {} },
  groups: [{ emoji_id: null, emoji: { name: '👍', content: '👍' }, count: 2, current_user_reacted: false, reactions: [] }],
  quickReactEnabled: true,
  doubleClick: true,
  doubleTap: true,
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
vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => loose({ getMessageReactions: (id: string) => (id === 'msg-1' ? shared.groups : []) }),
}))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => loose({}) }))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => loose({ threadForMessage: () => null, threadsForChannel: () => [] }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({ isCurrentUserServerOwner: ref(false), canManageMessages: ref(false), getCurrentUserRole: ref(null) }),
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
    doubleClick: computed(() => shared.doubleClick),
    doubleTap: computed(() => shared.doubleTap),
    emoji: ref({ id: 'thumbs', name: 'thumbs', url: '', content: '👍' }),
  }),
}))
vi.mock('@/composables/useLayoutState', () => ({ useLayoutState: () => ({ isMobile: ref(false) }), isMobileLayout: () => false }))
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
import { closeEmojiInfo, useEmojiInfo } from '@/composables/useEmojiInfo'

const ReactionsStub = defineComponent({
  name: 'MessageReactions',
  props: { message: { type: Object, required: true } },
  emits: ['reaction-info'],
  setup() {
    return () => h('div', { class: 'message-reactions' }, [h('div', { class: 'reaction' }, '👍 2')])
  },
})

const row = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  created_at: new Date(),
  channel_id: 'chan-1',
  user_id: 'them',
  content: [{ type: 'text', text: 'hello' }],
  ...overrides,
})

const mountDisplay = (messages: Message[] = [row()]) => shallowMount(MessageDisplay, {
  props: { messages, currentUserId: 'me', channelId: 'chan-1' },
  global: { mocks: { $t: (key: string) => key }, stubs: { MessageReactions: ReactionsStub } },
})

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] })

beforeEach(() => {
  vi.useFakeTimers()
  shared.outbox = { has: () => false, discard: vi.fn() }
  shared.quickReactEnabled = true
  shared.doubleClick = true
  shared.doubleTap = true
})

afterEach(() => {
  closeEmojiInfo()
  vi.useRealTimers()
})

describe('MessageDisplay touches on reaction pills', () => {
  it('sends no quick reaction on a double tap of a pill', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    const pill = wrapper.get('.message-reactions .reaction')
    await pill.trigger('touchend')
    await pill.trigger('touchend')
    expect(wrapper.emitted('sendReaction')).toBeUndefined()

    const body = wrapper.get('.message-item')
    await body.trigger('touchend')
    await body.trigger('touchend')
    expect(wrapper.emitted('sendReaction')?.[0]?.[0]).toBe('msg-1')
  })

  it('opens no action bar on a long-press of a pill', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    await wrapper.get('.message-reactions .reaction').trigger('touchstart', touch(10, 10))
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(wrapper.find('.message-actions').exists()).toBe(false)

    await wrapper.get('.message-item').trigger('touchstart', touch(10, 10))
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(wrapper.find('.message-actions').exists()).toBe(true)
  })
})

describe('MessageDisplay quick react switches', () => {
  const doubleClick = async (el: ReturnType<ReturnType<typeof mountDisplay>['get']>) => {
    await el.trigger('mousedown', { button: 0, detail: 1, clientX: 40, clientY: 10 })
    await el.trigger('dblclick', { button: 0, clientX: 40, clientY: 10 })
  }

  it('reacts on a double tap only while double tap is on', async () => {
    shared.doubleTap = false
    const wrapper = mountDisplay()
    await flushPromises()
    const body = wrapper.get('.message-item')
    await body.trigger('touchend')
    await body.trigger('touchend')
    expect(wrapper.emitted('sendReaction')).toBeUndefined()

    await doubleClick(body)
    expect(wrapper.emitted('sendReaction')).toBeUndefined()
    vi.advanceTimersByTime(1000)
  })

  it('reacts on a double-click only while double-click is on', async () => {
    shared.doubleClick = false
    const off = mountDisplay()
    await flushPromises()
    await doubleClick(off.get('.message-item'))
    expect(off.emitted('sendReaction')).toBeUndefined()

    shared.doubleClick = true
    shared.doubleTap = false
    const on = mountDisplay()
    await flushPromises()
    await doubleClick(on.get('.message-item'))
    expect(on.emitted('sendReaction')?.[0]?.[0]).toBe('msg-1')
  })
})

describe('MessageDisplay message long-press', () => {
  it('survives jitter under the tolerance', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    const item = wrapper.get('.message-item')
    await item.trigger('touchstart', touch(100, 100))
    await item.trigger('touchmove', touch(106, 108))
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(wrapper.find('.message-actions').exists()).toBe(true)
  })

  it('cancels on a drag past the tolerance', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    const item = wrapper.get('.message-item')
    await item.trigger('touchstart', touch(100, 100))
    await item.trigger('touchmove', touch(100, 115))
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(wrapper.find('.message-actions').exists()).toBe(false)
  })

  it('cancels on touchcancel', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    const item = wrapper.get('.message-item')
    await item.trigger('touchstart', touch(100, 100))
    await item.trigger('touchcancel')
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(wrapper.find('.message-actions').exists()).toBe(false)
  })
})

describe('MessageDisplay reactions list', () => {
  it('opens on the pill emoji from its info card and closes', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ReactionsModal' }).exists()).toBe(false)

    const anchor = wrapper.get('.message-reactions .reaction').element as HTMLElement
    wrapper.findComponent(ReactionsStub).vm.$emit('reaction-info', 'msg-1', '👍', anchor, 'click')
    const { request } = useEmojiInfo()
    expect(request.value).toMatchObject({ mode: 'pinned', anchor, target: { kind: 'default', glyph: '👍' } })
    expect(request.value!.reactions!.count()).toBe(2)
    request.value!.reactions!.onShowAll!()
    await flushPromises()
    expect(request.value).toBeNull()
    const modal = wrapper.findComponent({ name: 'ReactionsModal' })
    expect(modal.props()).toMatchObject({ messageId: 'msg-1', initialEmojiKey: '👍' })

    modal.vm.$emit('close')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ReactionsModal' }).exists()).toBe(false)
  })

  it('opens on the first tab from the context menu', async () => {
    const wrapper = mountDisplay()
    await flushPromises()
    wrapper.findComponent({ name: 'MessageContextMenu' }).vm.$emit('view-reactions', row())
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ReactionsModal' }).props()).toMatchObject({
      messageId: 'msg-1',
      initialEmojiKey: null,
    })
  })
})
