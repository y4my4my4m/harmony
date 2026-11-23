/**
 * RoleManagement.vue Members tab, Add members: the instance leaves the role's members out of the
 * search, and an answer for a role, server or visit the view has left lands nowhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { supabase } from '@/supabase'

const { state, roleServiceMock, politeMock, confirmMock } = vi.hoisted(() => ({
  state: { profileId: 'u-owner', ownerId: 'u-owner', roles: [] as any[], myRoles: [] as any[], myPermissions: {} as Record<string, boolean> },
  roleServiceMock: {
    getServerRoles: vi.fn(),
    getUserPermissions: vi.fn(),
    getUserRoles: vi.fn(),
    getRoleMembers: vi.fn(),
    reorderRoles: vi.fn(),
    updateRole: vi.fn(),
    createRole: vi.fn(),
    deleteRole: vi.fn(),
    removeRole: vi.fn(),
    assignRole: vi.fn(),
  },
  politeMock: vi.fn(),
  confirmMock: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, a?: unknown, b?: unknown) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    const count = typeof a === 'number' ? a : typeof b === 'number' ? b : undefined
    const named: Record<string, unknown> = { ...(typeof a === 'object' && a ? a : {}), ...(count !== undefined ? { count, n: count } : {}) }
    if (count !== undefined && message.includes(' | ')) {
      const forms = message.split(' | ')
      message = forms[forms.length === 3 ? Math.min(count, 2) : count === 1 ? 0 : 1]
    }
    return message
      .replace(/\{'([^']*)'\}/g, '$1')
      .replace(/\{(\w+)\}/g, (_: string, name: string) => String(named[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/services/RoleService', () => ({ roleService: roleServiceMock }))
vi.mock('@/services/bridgedChannelUsersService', () => ({
  fetchBridgedServerUsers: vi.fn().mockResolvedValue({ users: [] }),
}))
vi.mock('@/stores/useProfile', () => ({
  useProfileStore: () => ({ get profile() { return { id: state.profileId, is_admin: false } } }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ polite: politeMock, assertive: vi.fn(), announce: vi.fn() }),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name,
      props: ['src', 'alt', 'size', 'userId', 'fallback', 'title', 'icon', 'color', 'label', 'modelValue', 'labelledby', 'describedby', 'disabled'],
      render() { return h('span', { class: name }, this.fallback ?? '') },
    }),
  }
}
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/common/ColorPicker.vue', () => stub('ColorPicker'))
vi.mock('@/components/common/ToggleSwitch.vue', () => stub('ToggleSwitch'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
// Sortable needs pointer events; the stub renders the keyed item slot per element.
vi.mock('vuedraggable', async () => {
  const { defineComponent, h, cloneVNode } = await import('vue')
  return {
    default: defineComponent({
      name: 'DraggableStub',
      inheritAttrs: false,
      props: { modelValue: { type: Array, default: () => [] }, itemKey: String, tag: { type: String, default: 'div' } },
      setup(props, { slots, attrs }) {
        return () => h(
          props.tag,
          { class: attrs.class, 'aria-labelledby': attrs['aria-labelledby'] },
          (props.modelValue as any[]).flatMap(element =>
            (slots.item?.({ element }) ?? []).map(vnode => cloneVNode(vnode, { key: element[props.itemKey!] }))),
        )
      },
    }),
  }
})

const search = vi.hoisted(() => ({
  calls: [] as Array<{ serverId: string; query: string; limit: number; options: any }>,
  pending: [] as Array<(rows: any[]) => void>,
}))
vi.mock('@/services/memberDirectoryService', () => ({
  searchServerMembers: vi.fn((serverId: string, query: string, limit: number, options: any) => {
    search.calls.push({ serverId, query, limit, options })
    return new Promise((resolve) => { search.pending.push(resolve) })
  }),
  fetchRoleMemberCounts: vi.fn(async () => null),
}))

const { default: RoleManagement } = await import('../RoleManagement.vue')

enableAutoUnmount(afterEach)

const role = (id: string, name: string, position: number, extra: Record<string, unknown> = {}) => ({
  id, name, position, server_id: 's1', color: '#99AAB5', hoist: false, mentionable: false, permissions: {}, member_count: 0, ...extra,
})

function chain(table: string) {
  if (table === 'servers') {
    return { select: () => ({ eq: () => ({ single: async () => ({ data: { owner: state.ownerId }, error: null }) }) }) }
  }
  return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
}

async function mountRoles() {
  const wrapper = mount(RoleManagement, { props: { serverId: 's1' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

type W = Awaited<ReturnType<typeof mountRoles>>
const pills = (w: W) => w.findAll('.role-pill')
const pill = (w: W, name: string) => pills(w).find(p => p.find('.role-pill-name').text() === name)!

beforeEach(() => {
  document.body.innerHTML = ''
  state.profileId = 'u-owner'
  state.ownerId = 'u-owner'
  state.myRoles = []
  state.myPermissions = {}
  state.roles = [
    role('r-admin', 'Admins', 3, { is_admin: true }),
    role('r-mod', 'Mods', 2),
    role('r-jr', 'Juniors', 1),
    role('r-everyone', '@everyone', 0, { is_default: true }),
  ]
  vi.mocked(supabase.from).mockImplementation(chain as any)
  roleServiceMock.getServerRoles.mockImplementation(async () => state.roles.map(r => ({ ...r })))
  roleServiceMock.getUserPermissions.mockImplementation(async () => state.myPermissions)
  roleServiceMock.getUserRoles.mockImplementation(async () => state.myRoles)
  roleServiceMock.getRoleMembers.mockResolvedValue([])
  roleServiceMock.reorderRoles.mockReset().mockResolvedValue(true)
  roleServiceMock.updateRole.mockReset()
  roleServiceMock.removeRole.mockReset()
  politeMock.mockReset()
})


async function openMembersTab(w: W, roleName = 'Mods') {
  await pill(w, roleName).trigger('click')
  await flushPromises()
  await w.findAll('[role="tab"]')[2].trigger('click')
  await nextTick()
}

async function typeSearch(w: W, text: string) {
  const input = w.find('.members-block input.form-input')
  await input.setValue(text)
  await input.trigger('input')
  vi.advanceTimersByTime(250)
  await flushPromises()
}

const rows = (...names: string[]) => names.map(n => ({ id: `u-${n}`, username: n, display_name: n.toUpperCase() }))
const listed = (w: W) => w.findAll('.member-row-add').map(b => b.text())

describe('RoleManagement add members', () => {
  beforeEach(() => {
    search.calls.length = 0
    search.pending.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('asks the instance for members without the role', async () => {
    const w = await mountRoles()
    await openMembersTab(w)
    await typeSearch(w, 'zed')
    expect(search.calls).toEqual([{ serverId: 's1', query: 'zed', limit: 10, options: { withoutRole: 'r-mod' } }])
    search.pending[0](rows('zed'))
    await flushPromises()
    expect(listed(w)).toEqual(['ZED+'])
  })

  it('an answer for the server it left lists nothing', async () => {
    const w = await mountRoles()
    await openMembersTab(w)
    await typeSearch(w, 'zed')
    await w.setProps({ serverId: 's2' })
    await flushPromises()
    await openMembersTab(w)

    search.pending[0](rows('oldserver'))
    await flushPromises()
    await w.find('.members-block input.form-input').setValue('z')
    await nextTick()
    expect(listed(w)).toEqual([])
    expect(w.text()).not.toContain('OLDSERVER')
  })

  it('an answer for the role it left lists nothing', async () => {
    const w = await mountRoles()
    await openMembersTab(w)
    await typeSearch(w, 'zed')
    await openMembersTab(w, 'Juniors')

    search.pending[0](rows('formod'))
    await flushPromises()
    await w.find('.members-block input.form-input').setValue('z')
    await nextTick()
    expect(listed(w)).toEqual([])
  })

  it('an answer landing after the view is hidden is not shown on the next visit', async () => {
    const { KeepAlive, defineComponent, h, ref } = await import('vue')
    const shown = ref(true)
    const Host = defineComponent({
      setup: () => () => h(KeepAlive, null, shown.value ? [h(RoleManagement, { serverId: 's1' })] : []),
    })
    const host = mount(Host, { attachTo: document.body })
    await flushPromises()
    const w = host.findComponent(RoleManagement) as unknown as W
    await openMembersTab(w)
    await typeSearch(w, 'zed')

    shown.value = false
    await flushPromises()
    search.pending[0](rows('stale'))
    await flushPromises()
    shown.value = true
    await flushPromises()

    expect(host.text()).not.toContain('STALE')
    host.unmount()
  })
})
