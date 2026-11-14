/**
 * Edit Category loads the category's permissions each time it opens. Only the latest load lands,
 * and a failed load leaves the privacy toggle disabled with an error instead of showing the
 * category as not private.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { CategoryOverride } from '@/services/categoryPermissions'

const loads = vi.hoisted(() => [] as Array<{ categoryId: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>)

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/composables/useDialog', () => ({ useDialog: () => ({ titleId: 'category-edit-title' }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ updateCategory: vi.fn(async () => {}), setCategoryTemplate: vi.fn(async () => []) }),
}))
vi.mock('@/services/RoleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/RoleService')>()),
  roleService: {
    getRolesForServer: vi.fn(async () => [{ id: 'everyone', name: '@everyone', position: 0, color: null, is_default: true }]),
  },
}))
vi.mock('@/services/categoryPermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/categoryPermissions')>()),
  getCategoryOverrides: (categoryId: string) =>
    new Promise((resolve, reject) => loads.push({ categoryId, resolve, reject })),
}))
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', props: ['name', 'size'], render: () => h('span') }) }
})
vi.mock('@/components/CategoryPrivacyFields.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'CategoryPrivacyFields',
      props: { modelValue: { type: Object, required: true }, serverId: String, disabled: Boolean },
      setup: (props) => () => h('div', {
        'data-testid': 'privacy-fields',
        'data-private': String((props.modelValue as { isPrivate: boolean }).isPrivate),
        'data-disabled': String(props.disabled),
      }),
    }),
  }
})

import CategoryEditModal from '../CategoryEditModal.vue'

const category = (id: string) => ({ id, name: `Cat ${id}`, server_id: 'srv', position: 0 }) as any
const row = (roleId: string, allow: number, deny = 0): CategoryOverride => ({
  target_type: 'role', role_id: roleId, user_id: null, allow_permissions: String(allow), deny_permissions: String(deny),
})
const PRIVATE = [row('everyone', 0, 2)]
const OPEN: CategoryOverride[] = []

const fields = () => document.body.querySelector('[data-testid="privacy-fields"]') as HTMLElement | null

async function openPermissions() {
  document.body.querySelector<HTMLElement>('[role="tab"][data-tab="permissions"]')!.click()
  await nextTick()
}

beforeEach(() => {
  loads.length = 0
  document.body.innerHTML = ''
})

describe('CategoryEditModal permissions load', () => {
  it('keeps the latest category open when an earlier load answers last', async () => {
    const wrapper = mount(CategoryEditModal, { props: { show: true, category: category('a') }, attachTo: document.body })
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, category: category('b') })
    expect(loads.map(l => l.categoryId)).toEqual(['a', 'b'])
    await openPermissions()

    loads[1].resolve(OPEN)
    await flushPromises()
    loads[0].resolve(PRIVATE)
    await flushPromises()

    expect(fields()?.dataset.private).toBe('false')
    wrapper.unmount()
  })

  it('stays loading until the latest load answers', async () => {
    const wrapper = mount(CategoryEditModal, { props: { show: true, category: category('a') }, attachTo: document.body })
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, category: category('b') })
    await openPermissions()
    loads[0].resolve(OPEN)
    await flushPromises()
    expect(fields()).toBeNull()
    loads[1].resolve(PRIVATE)
    await flushPromises()
    expect(fields()?.dataset.private).toBe('true')
    wrapper.unmount()
  })

  it('leaves the toggle disabled with an error, and no role editor, when the load fails', async () => {
    const wrapper = mount(CategoryEditModal, { props: { show: true, category: category('a') }, attachTo: document.body })
    await openPermissions()
    loads[0].reject(new Error('network'))
    await flushPromises()
    expect(fields()?.dataset.disabled).toBe('true')
    expect(document.body.querySelector('[data-testid="category-privacy-error"]')?.textContent).toContain('category.edit.permissionsFailed')
    expect(document.body.querySelector('[data-testid="permission-role-editor"]')).toBeNull()
    wrapper.unmount()
  })
})
