/**
 * The rail's funding heart: shown on mobile viewports only, on every route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'

const route = reactive({ name: 'Today' as string, fullPath: '/today', params: {} })
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => route,
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

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

vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ folders: [], currentServerId: null }),
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({}) }))
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({ notifications: [], unreadDMs: 0, unreadServerMentions: () => 0 }),
}))
vi.mock('@/composables/useUnreadCounts', () => ({
  useUnreadCounts: () => ({ getServerUnreadMessages: () => 0 }),
}))
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

const mountSidebar = () =>
  mount(ServerSidebar, {
    props: { servers: [] },
    global: { stubs: { teleport: true }, directives: { 'click-outside': {} } },
  })

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
  })

  it.each(ROUTES)('is absent on desktop on %s', (name, fullPath) => {
    route.name = name
    route.fullPath = fullPath
    const wrapper = mountSidebar()
    expect(wrapper.find('.funding-button').exists()).toBe(false)
    expect(wrapper.find('.fixed-footer').exists()).toBe(false)
  })

  it.each(ROUTES)('is present on mobile on %s', (name, fullPath) => {
    route.name = name
    route.fullPath = fullPath
    isMobileViewport.value = true
    const wrapper = mountSidebar()
    expect(wrapper.find('.funding-button').exists()).toBe(true)
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
    expect(wrapper.find('.update-ready-button').exists()).toBe(true)
    expect(wrapper.find('.funding-button').exists()).toBe(false)
  })
})
