/**
 * "Remove from {server} on {instance}" in the member menu: instance staff, a member from this
 * instance, a server hosted elsewhere. A moderator is not offered it for instance staff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { computed } from 'vue'

const h = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
  profile: { id: 'me', is_admin: true, is_moderator: false } as Record<string, unknown>,
  server: { id: 's1', name: 'Elsewhere', is_local_server: false } as Record<string, unknown>,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: h.t }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/chat/s1/c1' }) }))
vi.mock('@/services/instanceConfig', () => ({ getInstanceDomain: () => 'harmony.test' }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: h.profile }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 's1', get currentServer() { return h.server } }),
}))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({
    isBlocked: () => false, isMuted: () => false, blockedUsers: new Set(['x']), mutedUsers: new Set(), loadBlockingData: vi.fn(),
  }),
}))
vi.mock('@/composables/useUserData', () => ({
  useUserData: () => ({
    getCurrentUser: computed(() => ({ id: 'me' })),
    getUserDisplayName: () => computed(() => 'Bob'),
  }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { hasPermission: vi.fn(async () => false) },
  Permission: { KICK_MEMBERS: 'KICK_MEMBERS', BAN_MEMBERS: 'BAN_MEMBERS', CREATE_INVITE: 'CREATE_INVITE' },
}))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: vi.fn(async () => 'me') } }))
vi.mock('@/composables/useMenu', () => ({ useMenu: vi.fn() }))

import UserContextMenu from '../UserContextMenu.vue'

enableAutoUnmount(afterEach)

const BOB = { id: 'u-bob', username: 'bob', is_local: true } as any

async function menuFor(user: any) {
  const wrapper = mount(UserContextMenu, {
    props: { visible: false, user, position: { x: 0, y: 0 } },
    global: { stubs: { Icon: true } },
    attachTo: document.body,
  })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

const item = () => document.querySelector<HTMLElement>('[data-testid="user-menu-instance-remove"]')

beforeEach(() => {
  document.body.innerHTML = ''
  h.profile = { id: 'me', is_admin: true, is_moderator: false }
  h.server = { id: 's1', name: 'Elsewhere', is_local_server: false }
})

describe('UserContextMenu: removal by this instance\'s staff', () => {
  it('names the server and this instance, and emits the action', async () => {
    const wrapper = await menuFor(BOB)
    expect(item()?.textContent?.trim()).toBe('instanceServer.remove.action server=Elsewhere instance=harmony.test')
    item()!.click()
    expect(wrapper.emitted('action')?.[0]).toEqual(['instance-remove', BOB])
  })

  it('is absent on a server hosted here, for a member from elsewhere, for oneself and for non-staff', async () => {
    h.server = { id: 's1', name: 'Home', is_local_server: true }
    await menuFor(BOB)
    expect(item()).toBeNull()

    document.body.innerHTML = ''
    h.server = { id: 's1', name: 'Elsewhere', is_local_server: false }
    await menuFor({ id: 'u-rm', username: 'rm', is_local: false })
    expect(item()).toBeNull()

    document.body.innerHTML = ''
    await menuFor({ id: 'me', username: 'me', is_local: true })
    expect(item()).toBeNull()

    document.body.innerHTML = ''
    h.profile = { id: 'me', is_admin: false, is_moderator: false }
    await menuFor(BOB)
    expect(item()).toBeNull()
  })

  it('is offered to a moderator for a member, not for instance staff', async () => {
    h.profile = { id: 'me', is_admin: false, is_moderator: true }
    await menuFor(BOB)
    expect(item()).not.toBeNull()

    document.body.innerHTML = ''
    await menuFor({ ...BOB, is_admin: true })
    expect(item()).toBeNull()
  })
})
