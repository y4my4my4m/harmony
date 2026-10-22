/**
 * ChannelSidebar.vue category headers: a member sees a category only with a channel they see in
 * it; a channel manager sees every category, and one members cannot see carries an eye-off mark
 * saying so. A private category is marked for whoever sees it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const s = vi.hoisted(() => ({
  manager: true,
  privateChannels: new Set<string>(),
  privateCategories: new Set<string>(),
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
  const route = reactive({ params: {} as Record<string, string> })
  return {
    ...(await importOriginal<typeof import('vue-router')>()),
    useRoute: () => route,
    useRouter: () => ({ push: vi.fn(), resolve: () => ({ href: '/chat' }) }),
  }
})
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: computed(() => s.manager),
      isCurrentUserServerOwner: computed(() => false),
      channelPermissions: computed(() => ({ canReorderChannels: s.manager })),
    }),
  }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerVoice: vi.fn() }) }))
vi.mock('@/composables/useViewport', async () => {
  const { ref } = await import('vue')
  return { useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }) }
})
vi.mock('@/composables/useUnreadCounts', () => ({ useUnreadCounts: () => ({ getUnreadMessages: () => 0 }) }))
vi.mock('@/stores/useServerUsers', () => ({
  useServerUsersStore: () => ({
    userProfiles: {},
    usersInVoiceChannels: {},
    getUsersInVoiceChannel: () => [],
    getCallStartTime: () => null,
    setupVoiceChannelBroadcast: vi.fn(async () => {}),
  }),
}))
vi.mock('@/stores/useServerChannel', async () => {
  const { reactive } = await import('vue')
  const { categoryHiddenFromMembers } = await import('@/utils/categoryVisibility')
  const store = reactive({
    categories: [
      { id: 'k-text', name: 'Text Channels', order: 0 },
      { id: 'k-staff', name: 'Staff', order: 1 },
      { id: 'k-empty', name: 'Public', order: 2 },
      { id: 'k-club', name: 'Club', order: 3 },
    ],
    categoryChannels: {} as Record<string, { id: string }[]>,
    pendingStructureCreate: null,
    pendingInviteOpen: false,
    isPrivateChannel: (id: string) => s.privateChannels.has(id),
    isPrivateCategory: (id: string) => s.privateCategories.has(id),
    isCategoryHiddenFromMembers(id: string) {
      return categoryHiddenFromMembers(store.categoryChannels[id], (c) => s.privateChannels.has(c))
    },
    reorderChannelsInCategory: vi.fn(async () => {}),
    updateCategoryOrder: vi.fn(async () => {}),
  })
  return { useServerChannelStore: () => store }
})
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ unreadChannelMentions: () => 0, showToast: vi.fn() }),
}))
vi.mock('@/stores/useServerNotificationSettings', () => ({
  useServerNotificationSettingsStore: () => ({ isChannelMuted: () => false, load: vi.fn() }),
}))
vi.mock('@/stores/unifiedVoiceChannel', () => ({
  useUnifiedVoiceChannelStore: () => ({
    isConnected: false, currentChannelId: null, optimisticChannelId: null, effectiveChannelId: null, allParticipants: [],
  }),
}))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/activities', () => ({ useActivitiesStore: () => ({ byChannel: {}, refreshServer: vi.fn() }) }))
vi.mock('@/stores/useChannelEncryption', () => ({ useChannelEncryptionStore: () => ({ loadServer: vi.fn(), stateFor: () => null }) }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => ({ prefetchChannelMessages: vi.fn() }) }))
vi.mock('@/services/StatePersistence', () => ({
  statePersistence: { initialize: async () => {}, getServerCategoryStates: () => ({}), setCategoryCollapseState: async () => {} },
}))
vi.mock('@/services/ThreadService', () => ({ threadService: { getServerThreads: async () => [] } }))
vi.mock('@/stores/useThreads', () => ({
  useThreadsStore: () => ({ byId: {}, upsert: vi.fn(), activeChannelThreads: () => [] }),
  isOptimisticThreadId: () => false,
}))

import ChannelSidebar from '../ChannelSidebar.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'

enableAutoUnmount(afterEach)

const general = { id: 'general', name: 'general', type: 0, order: 0, category: 'k-text' }
const mods = { id: 'mods', name: 'mods', type: 0, order: 0, category: 'k-staff' }
const club = { id: 'club', name: 'club', type: 0, order: 0, category: 'k-club' }

/** The viewer's channels, as channels RLS returns them. */
function mountSidebar(channels: typeof general[]) {
  const categoryChannels: Record<string, typeof general[]> = {}
  for (const c of channels) (categoryChannels[c.category] ||= []).push(c)
  ;(useServerChannelStore() as any).categoryChannels = categoryChannels
  return mount(ChannelSidebar, {
    attachTo: document.body,
    props: { currentServer: { id: 's1', name: 'Hub' }, channels, categories: [], categoryChannels, currentChannelId: 'general' },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        ServerDropdown: true, CategoryCreator: true, InviteModal: true, VoiceChannelParticipants: true,
        VoiceChannelUserList: true, MobileVoiceChannelPreview: true, ChannelEditModal: true,
        CategoryEditModal: true, ConfirmationModal: true, ThreadEditModal: true, CategoryContextMenu: true,
        ThreadContextMenu: true, ChannelContextMenu: true,
      },
    },
  })
}

const headers = () => Array.from(document.querySelectorAll<HTMLElement>('.category-header'))
const header = (name: string) => headers().find(h => h.querySelector('.category-name')?.textContent === name)!

beforeEach(() => {
  s.manager = true
  s.privateChannels = new Set()
  s.privateCategories = new Set()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChannelSidebar category headers', () => {
  it('a member sees no header for a category without a channel they see', async () => {
    s.manager = false
    mountSidebar([general])
    await flushPromises()
    expect(headers().map(h => h.querySelector('.category-name')!.textContent)).toEqual(['Text Channels'])
  })

  it('a member allowed into a private category sees it, marked private', async () => {
    s.manager = false
    s.privateChannels = new Set(['club'])
    s.privateCategories = new Set(['k-club'])
    mountSidebar([general, club])
    await flushPromises()
    expect(headers().map(h => h.querySelector('.category-name')!.textContent)).toEqual(['Text Channels', 'Club'])
    expect(header('Club').dataset.private).toBe('true')
    expect(header('Club').querySelector('.category-lock .sr-only')!.textContent).toBe('label')
    expect(header('Club').dataset.hiddenFromMembers).toBeUndefined()
    expect(header('Text Channels').querySelector('.category-lock')).toBeNull()
  })

  it('a channel manager sees every header; those members cannot see are marked', async () => {
    s.privateChannels = new Set(['mods', 'club'])
    s.privateCategories = new Set(['k-club'])
    mountSidebar([general, mods, club])
    await flushPromises()
    expect(headers().map(h => h.querySelector('.category-name')!.textContent)).toEqual(['Text Channels', 'Staff', 'Public', 'Club'])
    expect(header('Text Channels').dataset.hiddenFromMembers).toBeUndefined()
    for (const name of ['Staff', 'Public', 'Club']) {
      expect(header(name).dataset.hiddenFromMembers).toBe('true')
      expect(header(name).querySelector('.category-lock')).not.toBeNull()
    }
    expect(header('Staff').querySelector('.category-lock .sr-only')!.textContent).toBe('hiddenFromMembers')
    expect(header('Club').querySelector('.category-lock .sr-only')!.textContent).toBe('label')
  })
})
