/**
 * RoleManagement.vue for keyboard and screen-reader users: keyboard reordering
 * (Move up/down and Alt+Arrow on a role) through the drag-drop save path with a
 * spoken position, the selected role as aria-current, the editor tablist, labelled
 * fields and named member controls.
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
      name: 'draggable',
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
const moveUp = (w: W) => w.find('[data-testid="role-move-up"]')
const moveDown = (w: W) => w.find('[data-testid="role-move-down"]')

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

describe('RoleManagement role list', () => {
  it('marks the selected role with aria-current and puts unsaved changes in its name', async () => {
    const w = await mountRoles()
    expect(pill(w, 'Admins').attributes('aria-current')).toBe('true')
    expect(pill(w, 'Mods').attributes('aria-current')).toBeUndefined()
    await pill(w, 'Mods').trigger('click')
    await flushPromises()
    expect(pill(w, 'Mods').attributes('aria-current')).toBe('true')
    expect(pill(w, 'Admins').attributes('aria-current')).toBeUndefined()

    await w.find('.role-editor input[type="text"]').setValue('Moderators')
    expect(pill(w, 'Mods').find('.sr-only').text()).toBe('Unsaved changes')
    expect(pill(w, 'Mods').find('.role-pill-dot').attributes('aria-hidden')).toBe('true')
  })

  it('is a list labelled by its role count', async () => {
    const w = await mountRoles()
    const list = w.find('ul.rail-list')
    expect(list.findAll('li')).toHaveLength(4)
    expect(document.getElementById(list.attributes('aria-labelledby')!)?.textContent?.trim()).toBe('4 roles')
  })

  it('moves the selected role up through the drag-drop save path and announces its position', async () => {
    const w = await mountRoles()
    await pill(w, 'Mods').trigger('click')
    await flushPromises()
    expect(moveUp(w).attributes('aria-label')).toBe('Move Mods up')
    expect(moveDown(w).attributes('aria-label')).toBe('Move Mods down')
    expect(document.getElementById(moveUp(w).attributes('aria-describedby')!)?.textContent?.trim()).toBe('Position 2 of 4')

    ;(moveUp(w).element as HTMLElement).focus()
    await moveUp(w).trigger('click')
    await flushPromises()

    expect(roleServiceMock.reorderRoles).toHaveBeenCalledWith('s1', [
      { id: 'r-mod', position: 4 },
      { id: 'r-admin', position: 3 },
      { id: 'r-jr', position: 2 },
    ])
    expect(politeMock).toHaveBeenCalledWith('Mods moved to position 1 of 4')
    expect(pills(w).map(p => p.find('.role-pill-name').text())).toEqual(['Mods', 'Admins', 'Juniors', '@everyone'])
    // At the top now: Move up is unavailable but keeps focus.
    expect(moveUp(w).attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(moveUp(w).element)
  })

  it('disables moves at the ends and never moves @everyone', async () => {
    const w = await mountRoles()
    expect(moveUp(w).attributes('aria-disabled')).toBe('true')
    expect(moveDown(w).attributes('aria-disabled')).toBeUndefined()

    await pill(w, 'Juniors').trigger('click')
    await flushPromises()
    expect(moveUp(w).attributes('aria-disabled')).toBeUndefined()
    expect(moveDown(w).attributes('aria-disabled')).toBe('true')
    await moveDown(w).trigger('click')
    await flushPromises()
    expect(roleServiceMock.reorderRoles).not.toHaveBeenCalled()

    await pill(w, '@everyone').trigger('click')
    await flushPromises()
    expect(moveUp(w).exists()).toBe(false)
    expect(pill(w, '@everyone').attributes('aria-keyshortcuts')).toBeUndefined()
  })

  it('locks roles at or above the manager\'s highest role', async () => {
    state.profileId = 'u-mgr'
    state.myPermissions = { MANAGE_ROLES: true }
    state.myRoles = [{ position: 10 }]
    state.roles = [
      role('r-sr', 'Seniors', 20),
      role('r-mgr', 'Managers', 10),
      role('r-jr', 'Juniors', 5),
      role('r-int', 'Interns', 3),
      role('r-everyone', '@everyone', 0, { is_default: true }),
    ]
    const w = await mountRoles()

    expect(pill(w, 'Seniors').attributes('aria-current')).toBe('true')
    expect(moveUp(w).attributes('aria-disabled')).toBe('true')
    expect(moveDown(w).attributes('aria-disabled')).toBe('true')

    await pill(w, 'Juniors').trigger('click')
    await flushPromises()
    expect(moveUp(w).attributes('aria-disabled')).toBe('true')
    expect(moveDown(w).attributes('aria-disabled')).toBeUndefined()
    await moveUp(w).trigger('click')
    await flushPromises()
    expect(roleServiceMock.reorderRoles).not.toHaveBeenCalled()

    await moveDown(w).trigger('click')
    await flushPromises()
    expect(roleServiceMock.reorderRoles).toHaveBeenCalledWith('s1', [
      { id: 'r-int', position: 5 },
      { id: 'r-jr', position: 3 },
    ])
  })

  it('moves the focused role with Alt+ArrowDown and keeps focus on it', async () => {
    const w = await mountRoles()
    const mods = pill(w, 'Mods')
    expect(mods.attributes('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    ;(mods.element as HTMLElement).focus()
    await mods.trigger('keydown', { key: 'ArrowDown', altKey: true })
    await flushPromises()
    await nextTick()

    expect(roleServiceMock.reorderRoles).toHaveBeenCalledTimes(1)
    expect(pills(w).map(p => p.find('.role-pill-name').text())).toEqual(['Admins', 'Juniors', 'Mods', '@everyone'])
    expect(politeMock).toHaveBeenCalledWith('Mods moved to position 3 of 4')
    expect((document.activeElement as HTMLElement).dataset.roleId).toBe('r-mod')
  })
})

describe('RoleManagement editor', () => {
  it('exposes the editor tabs as a tablist with arrow-key selection and labelled panels', async () => {
    const w = await mountRoles()
    const list = w.find('[role="tablist"]')
    expect(document.getElementById(list.attributes('aria-labelledby')!)?.textContent).toBe('Admins')
    const tabs = () => w.findAll('[role="tab"]')
    expect(tabs().map(t => t.text())).toEqual(['Display', 'Permissions', 'Members'])
    expect(tabs().map(t => t.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs().map(t => t.attributes('tabindex'))).toEqual(['0', '-1', '-1'])

    ;(tabs()[0].element as HTMLElement).focus()
    await tabs()[0].trigger('keydown', { key: 'ArrowRight' })
    await nextTick()
    expect(document.activeElement).toBe(tabs()[1].element)
    expect(tabs()[1].attributes('aria-selected')).toBe('true')
    const panel = w.find('[role="tabpanel"]')
    expect(panel.attributes('id')).toBe(tabs()[1].attributes('aria-controls'))
    expect(panel.attributes('aria-labelledby')).toBe(tabs()[1].attributes('id'))
    expect(panel.find('.perm-row').exists()).toBe(true)

    await tabs()[1].trigger('keydown', { key: 'End' })
    await nextTick()
    expect(document.activeElement).toBe(tabs()[2].element)
    expect(tabs()[2].attributes('aria-selected')).toBe('true')
  })

  it('labels the role name field', async () => {
    const w = await mountRoles()
    const input = w.find('.role-editor input[type="text"]')
    const label = w.find(`label[for="${input.attributes('id')}"]`)
    expect(label.text()).toBe('Role name')
  })

  it('names remove-member buttons with the member and role, and announces removal', async () => {
    roleServiceMock.getRoleMembers.mockResolvedValue([
      { id: 'u-alice', username: 'alice', display_name: 'Alice' },
      { id: 'u-bob', username: 'bob', display_name: 'Bob' },
    ])
    roleServiceMock.removeRole.mockResolvedValue(true)
    const w = await mountRoles()
    await pill(w, 'Mods').trigger('click')
    await flushPromises()
    await w.findAll('[role="tab"]')[2].trigger('click')
    await nextTick()

    const remove = w.findAll('[data-role-remove-member]')
    expect(remove.map(b => b.attributes('aria-label'))).toEqual(['Remove Alice from Mods', 'Remove Bob from Mods'])
    await remove[0].trigger('click')
    await flushPromises()
    expect(roleServiceMock.removeRole).toHaveBeenCalledWith('u-alice', 'r-mod')
    expect(politeMock).toHaveBeenCalledWith('Alice removed from Mods')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove Bob from Mods')
  })

  it('announces a save and keeps focus on Save', async () => {
    const w = await mountRoles()
    await pill(w, 'Mods').trigger('click')
    await flushPromises()
    roleServiceMock.updateRole.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...state.roles[1], ...patch, id }))
    await w.find('.role-editor input[type="text"]').setValue('Moderators')
    const save = w.find('.save-btn')
    expect(save.attributes('aria-disabled')).toBeUndefined()
    ;(save.element as HTMLElement).focus()
    await save.trigger('click')
    await flushPromises()
    expect(politeMock).toHaveBeenCalledWith('Role Moderators saved')
    expect(w.find('.save-btn').attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(w.find('.save-btn').element)
  })
})
