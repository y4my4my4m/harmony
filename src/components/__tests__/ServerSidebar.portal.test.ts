/**
 * ServerSidebar.vue portal: every activation requests the Discover modal, and
 * a resting pointer or focus warms the Discover list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { usePublicServersStore } from '@/stores/usePublicServers'
import ServerSidebar from '../ServerSidebar.vue'

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => reactive({ name: 'Chat', params: {}, fullPath: '/chat' }),
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({}) }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ notifications: [] }) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/useDesktopUpdater', async () => {
  const { reactive, ref } = await import('vue')
  return { useDesktopUpdater: () => ({ state: reactive({ availableVersion: null }), isReady: ref(false), openUpdatePrompt: vi.fn() }) }
})
vi.mock('@/composables/useUnreadCounts', () => ({ useUnreadCounts: () => ({ getServerUnreadMessages: () => 0 }) }))
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => ({ config: null, goalPillMounted: false, load: vi.fn(async () => {}) }) }))

describe('ServerSidebar portal', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const mountSidebar = () => shallowMount(ServerSidebar, {
    props: { servers: [] },
    global: { mocks: { $t: (key: string) => key }, directives: { 'click-outside': {} } },
  })

  it('requests the Discover modal on every click', async () => {
    const wrapper = mountSidebar()
    const portal = wrapper.find('.portal')
    await portal.trigger('click')
    await portal.trigger('click')
    await portal.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('show-public-servers')).toHaveLength(3)
  })

  it('warms the Discover list after the pointer rests on the portal', async () => {
    const store = usePublicServersStore()
    const fetch = vi.spyOn(store, 'fetchPublicServers').mockResolvedValue()
    const wrapper = mountSidebar()
    const portal = wrapper.find('.portal')

    await portal.trigger('mouseenter')
    vi.advanceTimersByTime(99)
    expect(fetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not warm the list for a pointer passing over the portal', async () => {
    const store = usePublicServersStore()
    const fetch = vi.spyOn(store, 'fetchPublicServers').mockResolvedValue()
    const wrapper = mountSidebar()
    const portal = wrapper.find('.portal')

    await portal.trigger('mouseenter')
    vi.advanceTimersByTime(50)
    await portal.trigger('mouseleave')
    vi.advanceTimersByTime(200)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('warms the list on keyboard focus', async () => {
    const store = usePublicServersStore()
    const fetch = vi.spyOn(store, 'fetchPublicServers').mockResolvedValue()
    const wrapper = mountSidebar()

    await wrapper.find('.portal').trigger('focus')
    vi.advanceTimersByTime(100)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
