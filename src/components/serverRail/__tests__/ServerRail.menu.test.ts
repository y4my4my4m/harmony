/**
 * Server rail context menus: the same server menu for loose servers and folder
 * members, the folder menu, and mark-as-read wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import type { Server, ServerFolder } from '@/types'

const push = vi.fn()
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push }),
  useRoute: () => ({ name: 'Chat', params: {}, fullPath: '/chat' }),
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
const leaveServer = vi.fn(async () => true)
vi.mock('@/composables/useLeaveServer', () => ({
  useLeaveServer: () => ({ leaveServer, isOwner: (s: { owner?: string }) => s.owner === 'me' }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
const canManage = ref(false)
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    serverSettingsPermissions: computed(() => ({ canEditBasicInfo: canManage.value, canViewSettings: true })),
    channelPermissions: computed(() => ({ canCreateChannels: canManage.value, canCreateCategories: canManage.value })),
  }),
}))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: false }), getCurrentProfileId: vi.fn() },
}))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn().mockReturnValue(() => {}), send: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: vi.fn(() => ({ session: { user: { id: 'me' } } })) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))

import ServerRail from '../ServerRail.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useNotificationStore } from '@/stores/useNotification'
import { supabase } from '@/supabase'

const s = (id: string, position: number, folder_id: string | null = null, owner = 'someone') =>
  ({ id, name: `name-${id}`, position, folder_id, owner, is_local_server: true }) as unknown as Server

function setup() {
  const store = useServerChannelStore()
  store.currentUserId = 'me'
  store.folders = [{ id: 'F1', user_id: 'me', name: 'Games', color: '#f00', position: 1, is_expanded: true } as ServerFolder]
  store.servers = [s('a', 0), s('b', 0, 'F1'), s('c', 1, 'F1'), s('d', 2, null, 'me')]
  return store
}

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

describe('ServerRail context menus', () => {
  let wrapper: VueWrapper
  let store: ReturnType<typeof setup>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = setup()
    rpc.mockReset()
    rpc.mockResolvedValue({ data: null, error: null })
    canManage.value = false
    push.mockReset()
    wrapper = mount(ServerRail, {
      props: { servers: store.servers },
      attachTo: document.body,
      global: { stubs: { Teleport: true } },
    })
  })

  afterEach(() => {
    wrapper.unmount()
  })

  const actions = () => wrapper.findAll('.rail-menu [data-action]').map(b => b.attributes('data-action'))

  // The first mount in a cold CI worker can close the menu as it opens; reopen until it holds.
  const openOn = async (kind: 'server' | 'folder', id: string) => {
    await vi.waitFor(async () => {
      if (!wrapper.find('.rail-menu [data-action]').exists()) {
        await wrapper.get(`[data-rail-kind="${kind}"][data-rail-id="${id}"]`).trigger('contextmenu', { clientX: 10, clientY: 10 })
      }
      expect(wrapper.find('.rail-menu [data-action]').exists()).toBe(true)
    }, { timeout: 4000 })
  }

  const base = ['mark-read', 'invite', 'mute', 'mute-m15', 'mute-h1', 'mute-h3', 'mute-h8', 'mute-h24', 'mute-forever', 'settings', 'move-up', 'move-down']

  it('gives a loose server the full menu', async () => {
    await openOn('server', 'a')
    expect(actions()).toEqual([...base, 'create-folder', 'move-to-folder', 'move-to-F1', 'copy-id', 'leave'])
  })

  it('gives a server inside a folder the same menu, with removal in place of creation', async () => {
    await openOn('server', 'b')
    expect(actions()).toEqual([...base, 'remove-from-folder', 'copy-id', 'leave'])
  })

  it('adds structure items with Manage Channels and drops leave for the owner', async () => {
    canManage.value = true
    await openOn('server', 'd')
    const list = actions()
    expect(list).toContain('create-channel')
    expect(list).toContain('create-category')
    expect(list).not.toContain('leave')
  })

  it('disables mark as read without unread state', async () => {
    await openOn('server', 'b')
    expect(wrapper.get('[data-action="mark-read"]').attributes('disabled')).toBeDefined()
  })

  it('marks a server inside a folder read', async () => {
    useNotificationStore().notifications = [
      { id: 'n1', type: 'mention', is_read: false, data: { server_id: 'b', channel_id: 'cb' } } as any,
    ]
    await openOn('server', 'b')
    const item = wrapper.get('[data-action="mark-read"]')
    expect(item.attributes('disabled')).toBeUndefined()
    await item.trigger('click')
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('mark_server_as_read', { p_server_id: 'b' })
    expect(useNotificationStore().notifications[0].is_read).toBe(true)
  })

  it('gives folders their menu and marks every member read', async () => {
    useNotificationStore().notifications = [
      { id: 'n1', type: 'mention', is_read: false, data: { server_id: 'c' } } as any,
    ]
    await openOn('folder', 'F1')
    expect(actions()).toEqual(['mark-read', 'settings', 'toggle', 'move-up', 'move-down', 'ungroup'])
    await wrapper.get('[data-action="mark-read"]').trigger('click')
    await flushPromises()
    expect(rpc.mock.calls.map(c => c[1].p_server_id).sort()).toEqual(['b', 'c'])
  })

  it('emits invite and edit-folder, routes settings', async () => {
    await openOn('server', 'b')
    await wrapper.get('[data-action="invite"]').trigger('click')
    expect(wrapper.emitted('invite')?.[0][0]).toMatchObject({ id: 'b' })

    await openOn('server', 'a')
    await wrapper.get('[data-action="settings"]').trigger('click')
    expect(push).toHaveBeenCalledWith('/server/a')

    await openOn('folder', 'F1')
    await wrapper.get('[data-action="settings"]').trigger('click')
    expect(wrapper.emitted('edit-folder')?.[0][0]).toMatchObject({ id: 'F1' })
  })

  it('leaves through the shared leave flow', async () => {
    await openOn('server', 'c')
    await wrapper.get('[data-action="leave"]').trigger('click')
    expect(leaveServer).toHaveBeenCalledWith('c')
  })

  it('queues channel creation for another server and selects it', async () => {
    canManage.value = true
    store.currentServerId = 'a'
    await openOn('server', 'c')
    await wrapper.get('[data-action="create-channel"]').trigger('click')
    expect(store.pendingStructureCreate).toEqual({ serverId: 'c', kind: 'channel' })
    expect(wrapper.emitted('select-server')?.[0]).toEqual(['c'])
  })

  it('closes on Escape', async () => {
    await openOn('server', 'a')
    await wrapper.get('.rail-menu').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.rail-menu').exists()).toBe(false)
  })
})
