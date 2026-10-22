/**
 * ChannelSidebar.vue for keyboard and screen-reader users: rows named with
 * type and state, voice rows as buttons with the join described and "Open
 * chat" beside them, one roving Tab stop, the context menu from the keyboard
 * and Alt+Arrow reordering with an announcement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { THROTTLE_MS, WRITE_DELAY_MS, announcerRegions, resetAnnouncer } from '@/composables/useAnnouncer'

const s = vi.hoisted(() => ({
  unread: {} as Record<string, number>,
  mentions: {} as Record<string, number>,
  muted: new Set<string>(),
  voiceUsers: {} as Record<string, string[]>,
  reorder: null as unknown as ReturnType<typeof vi.fn>,
  categoryOrder: null as unknown as ReturnType<typeof vi.fn>,
  joinVoice: null as unknown as ReturnType<typeof vi.fn>,
  push: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, named?: Record<string, unknown>) => {
      const leaf = key.split('.').pop()!
      return named ? `${leaf}(${Object.values(named).join(',')})` : leaf
    },
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('vue-router', async (importOriginal) => {
  const { reactive } = await import('vue')
  s.push = vi.fn()
  const route = reactive({ params: {} as Record<string, string> })
  return {
    ...(await importOriginal<typeof import('vue-router')>()),
    useRoute: () => route,
    useRouter: () => ({
      push: s.push,
      resolve: (loc: { params: Record<string, string> }) => ({
        href: loc.params.channelId ? `/chat/${loc.params.serverId}/${loc.params.channelId}` : `/chat/${loc.params.serverId}/thread/${loc.params.threadId}`,
      }),
    }),
  }
})
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed, ref } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: ref(true),
      isCurrentUserServerOwner: ref(true),
      channelPermissions: computed(() => ({ canReorderChannels: true })),
    }),
  }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerVoice: vi.fn() }) }))
vi.mock('@/composables/useViewport', async () => {
  const { ref } = await import('vue')
  return { useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }) }
})
vi.mock('@/composables/useUnreadCounts', () => ({
  useUnreadCounts: () => ({ getUnreadMessages: ({ channelId }: { channelId: string }) => s.unread[channelId] ?? 0 }),
}))
vi.mock('@/stores/useServerUsers', () => ({
  useServerUsersStore: () => ({
    userProfiles: {},
    usersInVoiceChannels: {},
    getUsersInVoiceChannel: (id: string) => s.voiceUsers[id] ?? [],
    getCallStartTime: () => null,
    setupVoiceChannelBroadcast: vi.fn(async () => {}),
  }),
}))
vi.mock('@/stores/useServerChannel', async () => {
  const { reactive } = await import('vue')
  s.reorder = vi.fn(async () => {})
  s.categoryOrder = vi.fn(async () => {})
  const store = reactive({
    categories: [
      { id: 'k-text', name: 'Text Channels', order: 0 },
      { id: 'k-voice', name: 'Voice Channels', order: 1 },
    ],
    pendingStructureCreate: null,
    pendingInviteOpen: false,
    isPrivateChannel: () => false,
    isPrivateCategory: () => false,
    isCategoryHiddenFromMembers: () => false,
    reorderChannelsInCategory: (...args: unknown[]) => s.reorder(...args),
    updateCategoryOrder: (...args: unknown[]) => s.categoryOrder(...args),
  })
  return { useServerChannelStore: () => store }
})
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ unreadChannelMentions: (id: string) => s.mentions[id] ?? 0, showToast: vi.fn() }),
}))
vi.mock('@/stores/useServerNotificationSettings', () => ({
  useServerNotificationSettingsStore: () => ({ isChannelMuted: (_s: string, id: string) => s.muted.has(id), load: vi.fn() }),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => {
  s.joinVoice = vi.fn(async () => true)
  return {
    useUnifiedVoiceChannelStore: () => ({
      isConnected: false,
      currentChannelId: null,
      optimisticChannelId: null,
      effectiveChannelId: null,
      allParticipants: [],
      joinVoiceChannel: s.joinVoice,
    }),
  }
})
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/activities', () => ({ useActivitiesStore: () => ({ byChannel: {}, refreshServer: vi.fn() }) }))
vi.mock('@/stores/useChannelEncryption', () => ({ useChannelEncryptionStore: () => ({ loadServer: vi.fn(), stateFor: () => null }) }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({ prefetchChannelMessages: vi.fn() }) }))
vi.mock('@/services/StatePersistence', () => ({
  statePersistence: { initialize: async () => {}, getServerCategoryStates: () => ({}), setCategoryCollapseState: async () => {} },
}))
vi.mock('@/services/ThreadService', () => ({ threadService: { getServerThreads: async () => [] } }))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => ({
    byId: {},
    upsert: vi.fn(),
    activeChannelThreads: (id: string) => (id === 'general' ? [{ id: 'th1', name: 'side talk', channel_id: 'general' }] : []),
  }),
  isOptimisticThreadId: () => false,
}))

const MenuStub = defineComponent({
  name: 'ChannelContextMenu',
  props: ['isVisible', 'channel', 'trigger', 'canMoveUp', 'canMoveDown', 'position', 'canReorder'],
  setup: (props) => () => (props.isVisible ? h('div', { 'data-testid': 'channel-menu' }, props.channel?.name) : null),
})

import ChannelSidebar from '../ChannelSidebar.vue'

enableAutoUnmount(afterEach)

const channels = [
  { id: 'general', name: 'general', type: 0, order: 0, category: 'k-text' },
  { id: 'random', name: 'random', type: 0, order: 1, category: 'k-text' },
  { id: 'quiet', name: 'quiet', type: 0, order: 2, category: 'k-text' },
  { id: 'lounge', name: 'Lounge', type: 1, order: 0, category: 'k-voice' },
]

function mountSidebar() {
  return mount(ChannelSidebar, {
    attachTo: document.body,
    props: {
      currentServer: { id: 's1', name: 'Hub' },
      channels,
      categories: [],
      categoryChannels: {
        'k-text': channels.filter((c) => c.category === 'k-text'),
        'k-voice': channels.filter((c) => c.category === 'k-voice'),
      },
      currentChannelId: 'general',
    },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        ServerDropdown: true,
        CategoryCreator: true,
        InviteModal: true,
        VoiceChannelParticipants: true,
        VoiceChannelUserList: true,
        MobileVoiceChannelPreview: true,
        ChannelEditModal: true,
        CategoryEditModal: true,
        ConfirmationModal: true,
        ThreadEditModal: true,
        CategoryContextMenu: true,
        ThreadContextMenu: true,
        ChannelContextMenu: MenuStub,
      },
    },
  })
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-nav-kind="channel"][data-nav-id="${id}"]`)!
/** Text content without aria-hidden parts: the name a row's content gives it. */
const nameOf = (el: Element): string => {
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
    return Array.from(node.childNodes).map(text).join('')
  }
  return text(el).replace(/\s+/g, ' ').trim()
}

function press(key: string, init: KeyboardEventInit = {}) {
  ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

beforeEach(() => {
  s.unread = { random: 2 }
  s.mentions = { random: 3 }
  s.muted = new Set(['quiet'])
  s.voiceUsers = { lounge: ['u1', 'u2'] }
  s.reorder.mockClear()
  s.categoryOrder.mockClear()
  s.joinVoice.mockClear()
  s.push.mockClear()
  resetAnnouncer()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChannelSidebar rows', () => {
  it('text channels are links named with type and state', async () => {
    mountSidebar()
    await flushPromises()
    expect(row('general').tagName).toBe('A')
    expect(row('general').getAttribute('href')).toBe('/chat/s1/general')
    expect(row('general').getAttribute('aria-current')).toBe('page')
    expect(nameOf(row('general'))).toBe('general, text')
    expect(nameOf(row('random'))).toBe('random, text, unread, mentions(3)')
    expect(nameOf(row('quiet'))).toBe('quiet, text, muted')
    expect(row('random').querySelector('.notification-badge')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('a voice channel is a button that says it joins, with Open chat beside it', async () => {
    mountSidebar()
    await flushPromises()
    const lounge = row('lounge')
    expect(lounge.tagName).toBe('BUTTON')
    expect(nameOf(lounge)).toBe('Lounge, voice, connected(2)')
    expect(document.getElementById(lounge.getAttribute('aria-describedby')!)?.textContent).toBe('joinHint')
    const chat = document.querySelector<HTMLElement>('[data-nav-kind="voice-chat"][data-nav-id="lounge"]')!
    expect(chat.getAttribute('aria-label')).toBe('openChat(Lounge)')
    expect(lounge.contains(chat)).toBe(false)
    chat.click()
    expect(s.push).toHaveBeenCalledWith({ name: 'ChatChannel', params: { serverId: 's1', channelId: 'lounge' } })
    expect(s.joinVoice).not.toHaveBeenCalled()
    lounge.click()
    await flushPromises()
    expect(s.joinVoice).toHaveBeenCalledWith('lounge', 's1')
  })

  it('threads are links with aria-current when open', async () => {
    mountSidebar()
    await flushPromises()
    const thread = document.querySelector<HTMLElement>('[data-nav-kind="thread"][data-nav-id="th1"]')!
    expect(thread.getAttribute('href')).toBe('/chat/s1/thread/th1')
    expect(thread.closest('ul')?.getAttribute('aria-label')).toBe('threadsOf(general)')
    expect(nameOf(thread)).toBe('side talk, thread')
  })
})

describe('ChannelSidebar keyboard', () => {
  it('keeps one Tab stop, on the current channel, and moves it with the arrows', async () => {
    mountSidebar()
    await flushPromises()
    const stops = () => Array.from(document.querySelectorAll('[data-roving-item][tabindex="0"]'))
    expect(stops()).toEqual([row('general')])
    row('general').focus()
    press('ArrowDown')
    expect(document.activeElement?.getAttribute('data-nav-id')).toBe('th1')
    press('ArrowDown')
    expect(document.activeElement).toBe(row('random'))
    expect(stops()).toEqual([row('random')])
  })

  it('Space on a link opens the channel', async () => {
    mountSidebar()
    await flushPromises()
    row('random').focus()
    press(' ')
    expect(s.push).toHaveBeenCalledWith({ name: 'ChatChannel', params: { serverId: 's1', channelId: 'random' } })
  })

  it('Shift+F10 opens the channel menu with the row as its trigger', async () => {
    const wrapper = mountSidebar()
    await flushPromises()
    row('random').focus()
    press('F10', { shiftKey: true })
    await nextTick()
    const menu = wrapper.findComponent(MenuStub)
    expect(menu.props('isVisible')).toBe(true)
    expect(menu.props('channel')).toMatchObject({ id: 'random' })
    expect(menu.props('trigger')).toBe(row('random'))
    expect(menu.props('canMoveUp')).toBe(true)
    expect(menu.props('canMoveDown')).toBe(true)
  })

  it('Alt+ArrowUp moves a channel, keeps focus on it and announces the new position', async () => {
    vi.useFakeTimers()
    try {
      mountSidebar()
      await flushPromises()
      row('random').focus()
      press('ArrowUp', { altKey: true })
      expect(s.reorder).toHaveBeenCalledWith('k-text', [
        expect.objectContaining({ id: 'random' }),
        expect.objectContaining({ id: 'general' }),
        expect.objectContaining({ id: 'quiet' }),
      ])
      await vi.runOnlyPendingTimersAsync()
      vi.advanceTimersByTime(THROTTLE_MS + WRITE_DELAY_MS + 1)
      expect(announcerRegions().politeText.value).toBe('moved(random,1,3)')
      expect(document.activeElement).toBe(row('random'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('the first channel does not move up; categories move with Alt+Arrow', async () => {
    mountSidebar()
    await flushPromises()
    row('general').focus()
    press('ArrowUp', { altKey: true })
    expect(s.reorder).not.toHaveBeenCalled()
    const voiceHeader = document.querySelector<HTMLElement>('[data-nav-kind="category"][data-nav-id="k-voice"]')!
    expect(voiceHeader.getAttribute('aria-expanded')).toBe('true')
    voiceHeader.focus()
    press('ArrowUp', { altKey: true })
    expect(s.categoryOrder).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'k-voice' }),
      expect.objectContaining({ id: 'k-text' }),
    ])
  })
})
