import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getServerRoles: vi.fn(),
  getUserRoles: vi.fn(),
  setMySelfAssignableRole: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: mocks.toastError, success: vi.fn() }) }))
vi.mock('@/services/RoleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/RoleService')>()),
  roleService: {
    getServerRoles: mocks.getServerRoles,
    getUserRoles: mocks.getUserRoles,
    setMySelfAssignableRole: mocks.setMySelfAssignableRole,
    onRolesChanged: vi.fn(),
    clearServerCache: vi.fn(),
  },
}))

import RoleMenuCard from '@/components/roles/RoleMenuCard.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useProfileStore } from '@/stores/useProfile'

const base = { server_id: 's1', hoist: false, mentionable: false, created_at: '', updated_at: '' }
const everyoneBits = { VIEW_CHANNEL: true, SEND_MESSAGES: true }
const ROLES = [
  { ...base, id: 'everyone', name: '@everyone', color: '', position: 0, is_default: true, permissions: everyoneBits },
  { ...base, id: 'red', name: 'Red', color: '#ff0000', position: 2, self_assignable: true, self_assign_group: 'Colours', permissions: everyoneBits },
  { ...base, id: 'blue', name: 'Blue', color: '#0000ff', position: 1, self_assignable: true, self_assign_group: 'Colours', permissions: everyoneBits },
  { ...base, id: 'he', name: 'he/him', color: '#888888', position: 1, self_assignable: true, self_assign_group: 'Pronouns', permissions: everyoneBits },
]

function setUp(currentServerId = 's1') {
  setActivePinia(createPinia())
  const servers = useServerChannelStore()
  servers.servers = [{ id: 's1', name: 'Home', is_local_server: true }] as any
  servers.currentServerId = currentServerId as any
  const profile = useProfileStore()
  profile.profile = { id: 'u1' } as any
}

async function render(menu = { type: 'role_menu' as const, serverId: 's1', group: 'Colours' }) {
  const wrapper = mount(RoleMenuCard, { props: { menu } })
  await flushPromises()
  return wrapper
}

const chip = (w: Awaited<ReturnType<typeof render>>, id: string) => w.find(`[data-testid="role-chip-${id}"]`)

beforeEach(() => {
  mocks.getServerRoles.mockReset().mockResolvedValue(ROLES)
  mocks.getUserRoles.mockReset().mockResolvedValue([ROLES[2]])
  mocks.setMySelfAssignableRole.mockReset().mockResolvedValue({ ok: true })
  mocks.toastError.mockReset()
})

describe('RoleMenuCard', () => {
  it('lists its group\'s roles, highest first, with the ones the viewer holds checked', async () => {
    setUp()
    const w = await render()
    const ids = w.findAll('[data-testid^="role-chip-"]').map((c) => c.attributes('data-testid'))
    expect(ids).toEqual(['role-chip-red', 'role-chip-blue'])
    expect(chip(w, 'blue').attributes('aria-checked')).toBe('true')
    expect(chip(w, 'red').attributes('aria-checked')).toBe('false')
  })

  it('takes a role at once and keeps it when the server agrees', async () => {
    setUp()
    const w = await render()
    await chip(w, 'red').trigger('click')
    expect(chip(w, 'red').attributes('aria-checked')).toBe('true')
    await flushPromises()
    expect(mocks.setMySelfAssignableRole).toHaveBeenCalledWith('u1', 's1', 'red', true)
    expect(chip(w, 'red').attributes('aria-checked')).toBe('true')
  })

  it('puts the chip back and says why when the server refuses', async () => {
    setUp()
    mocks.setMySelfAssignableRole.mockResolvedValue({ ok: false, error: 'ROLE_GRANTS_PERMISSIONS' })
    const w = await render()
    await chip(w, 'blue').trigger('click')
    await flushPromises()
    expect(mocks.setMySelfAssignableRole).toHaveBeenCalledWith('u1', 's1', 'blue', false)
    expect(chip(w, 'blue').attributes('aria-checked')).toBe('true')
    expect(mocks.toastError).toHaveBeenCalledWith('rolePicker.errors.notPickable')
  })

  it('offers nothing when shown in another server\'s channels', async () => {
    setUp('s2')
    const w = await render()
    expect(w.findAll('[data-testid^="role-chip-"]')).toHaveLength(0)
    expect(w.text()).toContain('roleMenu.otherServer')
    expect(mocks.getUserRoles).not.toHaveBeenCalled()
  })
})
