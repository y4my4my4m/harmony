/**
 * The rail's funding heart: mobile viewports only, on every route, as the last
 * item of the scrolling server list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import type { Server, ServerFolder } from '@/types'

const route = reactive({ name: 'Today' as string, fullPath: '/today', params: {} })
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => route,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))

const isMobileViewport = ref(false)
vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({
    viewportWidth: ref(1440),
    viewportHeight: ref(900),
    isMobileViewport,
    isTouchOnly: false,
    MOBILE_BREAKPOINT: 768,
  }),
}))

const fundingStore = reactive({ config: null as { enabled: boolean } | null, load: vi.fn() })
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => fundingStore }))

const updaterReady = ref(false)
vi.mock('@/composables/useDesktopUpdater', () => ({
  useDesktopUpdater: () => ({
    state: reactive({ availableVersion: '9.9.9' }),
    isReady: updaterReady,
    openUpdatePrompt: vi.fn(),
  }),
}))

const serverChannelStore = reactive({ folders: [] as ServerFolder[], currentServerId: null })
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => serverChannelStore,
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({}) }))
vi.mock('@/stores/usePublicServers', () => ({
  usePublicServersStore: () => ({ fetchPublicServers: vi.fn() }),
}))
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ notifications: [], unreadDMs: 0, unreadServerMentions: () => 0 }),
}))
vi.mock('@/composables/useUnreadCounts', async () => {
  const { computed } = await import('vue')
  return {
    useUnreadCounts: () => ({ getServerUnreadMessages: () => 0 }),
    serverUnreadTotals: computed(() => new Map()),
    clearServerUnread: () => {},
  }
})
vi.mock('@/composables/useLeaveServer', () => ({
  useLeaveServer: () => ({ leaveServer: vi.fn(), isOwner: () => false }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useTodayDashboard', () => ({
  useTodayDashboard: () => ({ todayDashboardEnabled: ref(true) }),
}))

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: { name, render: () => null } }),
}))
vi.mock('@/components/common/ServerIcon.vue', () => stub('ServerIcon'))
vi.mock('@/components/ServerFolder.vue', () => stub('ServerFolder'))
vi.mock('@/components/ServerFolderContextMenu.vue', () => stub('ServerFolderContextMenu'))
vi.mock('@/components/ServerFolderSettingsModal.vue', () => stub('ServerFolderSettingsModal'))
vi.mock('@/components/InviteModal.vue', () => stub('InviteModal'))
vi.mock('@/components/FundingModal.vue', () => stub('FundingModal'))

import ServerSidebar from '../ServerSidebar.vue'

const server = (id: string, name: string, position: number) =>
  ({ id, name, position, folder_id: null }) as unknown as Server

const folder = (id: string, position: number) =>
  ({ id, name: id, position, is_expanded: false, color: '#000' }) as unknown as ServerFolder

const mountSidebar = (servers: Server[] = []) =>
  mount(ServerSidebar, {
    props: { servers },
    global: { stubs: { teleport: true }, directives: { 'click-outside': {} } },
  })

const lastListChild = (wrapper: ReturnType<typeof mountSidebar>) =>
  wrapper.get('.servers-scroll-area').element.lastElementChild as HTMLElement

const ROUTES: Array<[string, string]> = [
  ['Today', '/today'],
  ['SocialHome', '/social/home'],
  ['ChatChannel', '/chat/s/c'],
  ['DMConversation', '/dm/c'],
  ['UserSettings', '/settings'],
]

describe('ServerSidebar funding heart', () => {
  beforeEach(() => {
    isMobileViewport.value = false
    updaterReady.value = false
    fundingStore.config = { enabled: true }
    serverChannelStore.folders = []
  })

  it.each(ROUTES)('is absent on desktop on %s', (name, fullPath) => {
    route.name = name
    route.fullPath = fullPath
    const wrapper = mountSidebar([server('s1', 'One', 0)])
    expect(wrapper.find('.funding-button').exists()).toBe(false)
    expect(wrapper.find('.funding-item-wrapper').exists()).toBe(false)
    expect(wrapper.find('.fixed-footer').exists()).toBe(false)
  })

  it.each(ROUTES)('is present on mobile on %s', (name, fullPath) => {
    route.name = name
    route.fullPath = fullPath
    isMobileViewport.value = true
    const wrapper = mountSidebar()
    expect(wrapper.find('.servers-scroll-area .funding-button').exists()).toBe(true)
  })

  it('is the last item of the server list, after servers and folders', () => {
    isMobileViewport.value = true
    serverChannelStore.folders = [folder('f1', 1)]
    const wrapper = mountSidebar([server('s1', 'One', 0), server('s3', 'Three', 2)])

    const last = lastListChild(wrapper)
    expect(last.classList.contains('funding-item-wrapper')).toBe(true)
    const entries = wrapper.findAll('.rail-list > .rail-entry')
    expect(entries.map(e => e.attributes('data-rail-root'))).toEqual(['s1', 'f1', 's3'])
    expect(wrapper.get('.rail-list').element.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const button = wrapper.get('.funding-item-wrapper > button.funding-button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Instance funding')
    expect(wrapper.find('.fixed-footer').exists()).toBe(false)
  })

  it('is the only item of an empty server list', () => {
    isMobileViewport.value = true
    const wrapper = mountSidebar()
    expect(wrapper.findAll('.rail-entry')).toHaveLength(0)
    expect(wrapper.findAll('.servers-scroll-area .funding-item-wrapper')).toHaveLength(1)
    expect(lastListChild(wrapper).classList.contains('funding-item-wrapper')).toBe(true)
  })

  it('stays after the drop indicator', () => {
    isMobileViewport.value = true
    const wrapper = mountSidebar([server('s1', 'One', 0)])
    const last = lastListChild(wrapper)
    expect(last.classList.contains('funding-item-wrapper')).toBe(true)
    expect((last.previousElementSibling as HTMLElement).classList.contains('rail-drop-indicator')).toBe(true)
  })

  it('opens and closes the funding modal', async () => {
    isMobileViewport.value = true
    const wrapper = mountSidebar([server('s1', 'One', 0)])
    expect(wrapper.findComponent({ name: 'FundingModal' }).exists()).toBe(false)

    await wrapper.get('.funding-button').trigger('click')
    const modal = wrapper.findComponent({ name: 'FundingModal' })
    expect(modal.exists()).toBe(true)

    modal.vm.$emit('close')
    await nextTick()
    expect(wrapper.findComponent({ name: 'FundingModal' }).exists()).toBe(false)
  })

  it('is absent on mobile while funding is disabled', () => {
    isMobileViewport.value = true
    fundingStore.config = { enabled: false }
    expect(mountSidebar().find('.funding-button').exists()).toBe(false)
  })

  it('follows the viewport across the breakpoint', async () => {
    const wrapper = mountSidebar()
    expect(wrapper.find('.funding-button').exists()).toBe(false)
    isMobileViewport.value = true
    await nextTick()
    expect(wrapper.find('.funding-button').exists()).toBe(true)
    isMobileViewport.value = false
    await nextTick()
    expect(wrapper.find('.funding-button').exists()).toBe(false)
  })

  it('leaves the update button in the desktop footer', () => {
    updaterReady.value = true
    const wrapper = mountSidebar()
    expect(wrapper.find('.fixed-footer .update-ready-button').exists()).toBe(true)
    expect(wrapper.find('.funding-button').exists()).toBe(false)
  })

  it('keeps the update button in the footer and the heart in the list on mobile', () => {
    isMobileViewport.value = true
    updaterReady.value = true
    const wrapper = mountSidebar([server('s1', 'One', 0)])
    const footer = wrapper.get('.fixed-footer')
    expect(footer.find('.update-ready-button').exists()).toBe(true)
    expect(footer.find('.funding-button').exists()).toBe(false)
    expect(lastListChild(wrapper).classList.contains('funding-item-wrapper')).toBe(true)
  })
})
