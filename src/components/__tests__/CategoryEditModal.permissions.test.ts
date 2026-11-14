/**
 * Edit Category's Permissions tab: the Private toggle and a Deny / Inherit / Allow editor per
 * role edit one template. Save applies the dialog's changes onto the template as it stands then.
 * Bits the editor does not show are kept, a role's changes reset alone, and closing with unsaved
 * changes asks first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { CategoryOverride } from '@/services/categoryPermissions'

const { confirmMock, setTemplateMock, updateCategoryMock, overrides, roleIdsMock, toastError } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  setTemplateMock: vi.fn(),
  updateCategoryMock: vi.fn(),
  overrides: { rows: [] as unknown[] },
  roleIdsMock: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: toastError }) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/composables/useDialog', () => ({ useDialog: () => ({ titleId: 'category-edit-title' }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ updateCategory: updateCategoryMock, setCategoryTemplate: setTemplateMock }),
}))
vi.mock('@/services/RoleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/RoleService')>()),
  roleService: {
    getRolesForServer: vi.fn(async () => [
      { id: 'everyone', name: '@everyone', position: 0, color: null, is_default: true },
      { id: 'mod', name: 'Moderator', position: 2, color: '#f00', is_default: false },
    ]),
  },
}))
vi.mock('@/services/categoryPermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/categoryPermissions')>()),
  getCategoryOverrides: vi.fn(async () => JSON.parse(JSON.stringify(overrides.rows))),
  getServerRoleIds: roleIdsMock,
}))
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', props: ['name', 'size'], render: () => h('span') }) }
})
// The stub's button stands for the Private toggle with Moderator chosen.
vi.mock('@/components/CategoryPrivacyFields.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'CategoryPrivacyFields',
      props: { modelValue: { type: Object, required: true }, serverId: String, disabled: Boolean },
      emits: ['update:modelValue'],
      setup: (props, { emit }) => () => h('button', {
        type: 'button',
        'data-testid': 'privacy-fields',
        'data-private': String((props.modelValue as { isPrivate: boolean }).isPrivate),
        onClick: () => emit('update:modelValue', { isPrivate: true, roleIds: ['mod'], userIds: [] }),
      }),
    }),
  }
})

import CategoryEditModal from '../CategoryEditModal.vue'

enableAutoUnmount(afterEach)

const category = { id: 'k1', name: 'Lounge', server_id: 'srv', position: 0 } as any
const row = (roleId: string, allow: number, deny = 0): CategoryOverride => ({
  target_type: 'role', role_id: roleId, user_id: null, allow_permissions: String(allow), deny_permissions: String(deny),
})
const byTarget = (rows: CategoryOverride[]) =>
  Object.fromEntries(rows.map(r => [r.role_id ?? r.user_id, `${r.allow_permissions}/${r.deny_permissions}`]))

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const radio = (perm: string, state: string) => $(`[data-perm="${perm}"] [role="radio"][data-state="${state}"]`)!
const pill = (roleId: string) => $(`.perm-role-pill[data-role-id="${roleId}"]`)!

async function openPermissions() {
  const wrapper = mount(CategoryEditModal, { props: { show: true, category }, attachTo: document.body })
  await flushPromises()
  $('[role="tab"][data-tab="permissions"]')!.click()
  await flushPromises()
  return wrapper
}

async function save() {
  $('[data-testid="category-edit-save"]')!.click()
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  overrides.rows = []
  confirmMock.mockReset()
  setTemplateMock.mockReset().mockResolvedValue(['c1'])
  updateCategoryMock.mockReset().mockResolvedValue(undefined)
  roleIdsMock.mockReset().mockResolvedValue(new Set(['everyone', 'mod']))
  toastError.mockReset()
})

describe('CategoryEditModal permissions', () => {
  it('opens on General with a Permissions tab beside it', async () => {
    mount(CategoryEditModal, { props: { show: true, category }, attachTo: document.body })
    await flushPromises()
    const tabs = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map(t => t.dataset.tab)).toEqual(['general', 'permissions'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect($('#category-name')).not.toBeNull()
    expect($('[data-testid="permission-role-editor"]')).toBeNull()
  })

  it('lists roles highest first, starts on @everyone, and offers text and voice permissions', async () => {
    await openPermissions()
    const pills = [...document.body.querySelectorAll<HTMLElement>('.perm-role-pill')]
    expect(pills.map(p => p.dataset.roleId)).toEqual(['mod', 'everyone'])
    expect(pill('everyone').getAttribute('aria-current')).toBe('true')
    for (const perm of ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_WEBHOOKS', 'CONNECT', 'SPEAK']) {
      expect($(`[data-perm="${perm}"]`)).not.toBeNull()
    }
  })

  it('shows the saved template and sends an edited one whole', async () => {
    overrides.rows = [row('everyone', 0, 2), row('mod', 2)]
    const wrapper = await openPermissions()
    expect(radio('VIEW_CHANNEL', 'deny').getAttribute('aria-checked')).toBe('true')

    pill('mod').click()
    await nextTick()
    expect(radio('VIEW_CHANNEL', 'allow').getAttribute('aria-checked')).toBe('true')
    radio('SEND_MESSAGES', 'deny').click()
    await nextTick()
    expect(radio('SEND_MESSAGES', 'deny').getAttribute('aria-checked')).toBe('true')
    expect(pill('mod').classList.contains('dirty')).toBe(true)
    expect(pill('everyone').classList.contains('dirty')).toBe(false)

    await save()
    expect(updateCategoryMock).not.toHaveBeenCalled()
    expect(setTemplateMock).toHaveBeenCalledTimes(1)
    expect(setTemplateMock.mock.calls[0][0]).toBe('k1')
    expect(byTarget(setTemplateMock.mock.calls[0][1])).toEqual({ everyone: '0/2', mod: '2/4096' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('applies the dialog\'s changes onto the template as it stands at save', async () => {
    overrides.rows = [row('everyone', 0, 2), row('mod', 2)]
    await openPermissions()
    pill('mod').click()
    await nextTick()
    radio('SEND_MESSAGES', 'deny').click()
    await nextTick()

    // Meanwhile @everyone is denied SEND_MESSAGES too, and the role edited here is deleted.
    overrides.rows = [row('everyone', 0, 2 | 4096)]
    roleIdsMock.mockResolvedValueOnce(new Set(['everyone']))
    await save()
    expect(byTarget(setTemplateMock.mock.calls[0][1])).toEqual({ everyone: `0/${2 | 4096}` })

    overrides.rows = [row('everyone', 0, 2)]
    await openPermissions()
    pill('mod').click()
    await nextTick()
    radio('SEND_MESSAGES', 'deny').click()
    overrides.rows = [row('everyone', 0, 2 | 4096)]
    await save()
    expect(byTarget(setTemplateMock.mock.calls[1][1])).toEqual({ everyone: `0/${2 | 4096}`, mod: '0/4096' })
  })

  it('saves nothing when the roles cannot be read, so no role row is lost', async () => {
    overrides.rows = [row('everyone', 0, 2), row('mod', 2)]
    const wrapper = await openPermissions()
    radio('SEND_MESSAGES', 'deny').click()
    await nextTick()
    roleIdsMock.mockRejectedValueOnce(new Error('offline'))
    await save()
    expect(setTemplateMock).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('keeps bits the editor does not show', async () => {
    // CREATE_PRIVATE_THREADS is bit 15 (32768), offered nowhere in the editor.
    overrides.rows = [row('mod', 32768)]
    await openPermissions()
    pill('mod').click()
    await nextTick()
    radio('ATTACH_FILES', 'allow').click()
    await save()
    const sent = byTarget(setTemplateMock.mock.calls[0][1])
    expect(BigInt(sent.mod.split('/')[0]) & BigInt(32768)).toBe(BigInt(32768))
  })

  it('the Private toggle and the editor edit one template', async () => {
    await openPermissions()
    $('[data-testid="privacy-fields"]')!.click()
    await nextTick()
    expect($('[data-testid="privacy-fields"]')!.dataset.private).toBe('true')
    expect(radio('VIEW_CHANNEL', 'deny').getAttribute('aria-checked')).toBe('true')
    pill('mod').click()
    await nextTick()
    expect(radio('VIEW_CHANNEL', 'allow').getAttribute('aria-checked')).toBe('true')

    // Allowing @everyone to view again makes the category public.
    pill('everyone').click()
    await nextTick()
    radio('VIEW_CHANNEL', 'inherit').click()
    await nextTick()
    expect($('[data-testid="privacy-fields"]')!.dataset.private).toBe('false')
  })

  it('Reset changes restores one role and leaves the others edited', async () => {
    overrides.rows = [row('mod', 2)]
    await openPermissions()
    radio('SEND_MESSAGES', 'deny').click()
    pill('mod').click()
    await nextTick()
    radio('VIEW_CHANNEL', 'deny').click()
    await nextTick()
    $<HTMLButtonElement>('.perm-reset-link')!.click()
    await flushPromises()
    expect(radio('VIEW_CHANNEL', 'allow').getAttribute('aria-checked')).toBe('true')
    expect(pill('mod').classList.contains('dirty')).toBe(false)
    expect(pill('everyone').classList.contains('dirty')).toBe(true)
  })

  it('asks before Cancel drops an unsaved permission, and closes at once with nothing changed', async () => {
    const wrapper = await openPermissions()
    $('.btn-secondary')!.click()
    await flushPromises()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)

    radio('SEND_MESSAGES', 'deny').click()
    await nextTick()
    confirmMock.mockResolvedValueOnce(false)
    $('.btn-secondary')!.click()
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toHaveLength(1)

    confirmMock.mockResolvedValueOnce(true)
    $('.btn-secondary')!.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(setTemplateMock).not.toHaveBeenCalled()
  })

  it('a rename alone writes no template', async () => {
    mount(CategoryEditModal, { props: { show: true, category }, attachTo: document.body })
    await flushPromises()
    const input = $<HTMLInputElement>('#category-name')!
    input.value = 'Lobby'
    input.dispatchEvent(new Event('input'))
    await save()
    expect(updateCategoryMock).toHaveBeenCalledWith({ id: 'k1', name: 'Lobby' })
    expect(setTemplateMock).not.toHaveBeenCalled()
  })
})
