/**
 * Edit Category loads the category's privacy each time it opens. Only the latest load lands,
 * and a failed load leaves the privacy toggle disabled with an error instead of showing the
 * category as not private.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const loads = vi.hoisted(() => [] as Array<{ categoryId: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>)

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/composables/useDialog', () => ({ useDialog: () => ({ titleId: 'category-edit-title' }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ updateCategory: vi.fn(async () => {}), setCategoryPrivacy: vi.fn(async () => []) }),
}))
vi.mock('@/services/RoleService', () => ({ roleService: { getRolesForServer: vi.fn(async () => []) } }))
vi.mock('@/services/categoryPermissions', () => ({
  getCategoryOverrides: (categoryId: string) =>
    new Promise((resolve, reject) => loads.push({ categoryId, resolve, reject })),
  privacyFromOverrides: (rows: unknown) => rows,
}))
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
const PRIVATE = { isPrivate: true, roleIds: ['r1'], userIds: [] }
const OPEN = { isPrivate: false, roleIds: [], userIds: [] }

const fields = () => document.body.querySelector('[data-testid="privacy-fields"]') as HTMLElement | null

beforeEach(() => {
  loads.length = 0
  document.body.innerHTML = ''
})

describe('CategoryEditModal privacy load', () => {
  it('keeps the latest category open when an earlier load answers last', async () => {
    const wrapper = mount(CategoryEditModal, { props: { show: true, category: category('a') }, attachTo: document.body })
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, category: category('b') })
    expect(loads.map(l => l.categoryId)).toEqual(['a', 'b'])

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
    loads[0].resolve(OPEN)
    await flushPromises()
    expect(fields()).toBeNull()
    loads[1].resolve(PRIVATE)
    await flushPromises()
    expect(fields()?.dataset.private).toBe('true')
    wrapper.unmount()
  })

  it('leaves the toggle disabled with an error when the load fails', async () => {
    const wrapper = mount(CategoryEditModal, { props: { show: true, category: category('a') }, attachTo: document.body })
    loads[0].reject(new Error('network'))
    await flushPromises()
    expect(fields()?.dataset.disabled).toBe('true')
    expect(document.body.querySelector('[data-testid="category-privacy-error"]')?.textContent).toContain('category.edit.permissionsFailed')
    wrapper.unmount()
  })
})
