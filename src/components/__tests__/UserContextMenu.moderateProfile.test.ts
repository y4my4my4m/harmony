/** "Change nickname" / "Reset server profile" for other members: MANAGE_NICKNAMES and outranking the target. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { computed } from 'vue'

const h = vi.hoisted(() => ({
  perms: new Set<string>(['MANAGE_NICKNAMES']),
  outranks: true,
  server: { id: 's1', name: 'Home', is_local_server: true, owner: 'someone' } as Record<string, unknown>,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (k: string) => k }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/chat/s1/c1' }) }))
vi.mock('@/services/instanceConfig', () => ({ getInstanceDomain: () => 'harmony.test' }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
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
  roleService: {
    hasPermission: vi.fn(async (_u: string, _s: string, p: string) => h.perms.has(p)),
    canManageUser: vi.fn(async () => h.outranks),
  },
  Permission: {
    KICK_MEMBERS: 'KICK_MEMBERS', BAN_MEMBERS: 'BAN_MEMBERS', CREATE_INVITE: 'CREATE_INVITE',
    MANAGE_NICKNAMES: 'MANAGE_NICKNAMES',
  },
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
const nick = () => document.querySelector('[data-testid="user-menu-moderate-nickname"]')
const reset = () => document.querySelector('[data-testid="user-menu-reset-server-profile"]')

beforeEach(() => {
  document.body.innerHTML = ''
  h.perms = new Set(['MANAGE_NICKNAMES'])
  h.outranks = true
  h.server = { id: 's1', name: 'Home', is_local_server: true, owner: 'someone' }
})

describe('UserContextMenu: moderate server profile', () => {
  it('shows both items and emits their actions', async () => {
    const wrapper = await menuFor(BOB)
    expect(nick()).not.toBeNull()
    expect(reset()).not.toBeNull()
    ;(nick() as HTMLElement).click()
    ;(reset() as HTMLElement).click()
    expect(wrapper.emitted('action')?.map(a => a[0])).toEqual(['moderate-nickname', 'reset-server-profile'])
  })

  it('hides both without MANAGE_NICKNAMES', async () => {
    h.perms = new Set()
    await menuFor(BOB)
    expect(nick()).toBeNull()
    expect(reset()).toBeNull()
  })

  it('hides both for a target the viewer does not outrank', async () => {
    h.outranks = false
    await menuFor(BOB)
    expect(nick()).toBeNull()
    expect(reset()).toBeNull()
  })

  it('hides both for oneself and on a server hosted elsewhere', async () => {
    await menuFor({ id: 'me', username: 'me', is_local: true })
    expect(nick()).toBeNull()
    document.body.innerHTML = ''
    h.server = { id: 's1', name: 'Away', is_local_server: false, owner: 'x' }
    await menuFor(BOB)
    expect(nick()).toBeNull()
  })

  it('lets the owner act on anyone, and hides both for the owner as a target', async () => {
    h.server = { id: 's1', name: 'Home', is_local_server: true, owner: 'me' }
    h.outranks = false
    await menuFor(BOB)
    expect(nick()).not.toBeNull()

    document.body.innerHTML = ''
    h.server = { id: 's1', name: 'Home', is_local_server: true, owner: 'u-bob' }
    h.outranks = true
    await menuFor(BOB)
    expect(nick()).toBeNull()
  })
})
