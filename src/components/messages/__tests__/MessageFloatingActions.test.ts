// The phone's floating message actions: instance staff's Delete on another member's message in a
// copy is "Hide on {instance}" with the eye-off icon, as in the hover bar and the context menu.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

vi.mock('@/composables/useT', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/Icon.vue', () => ({
  default: defineComponent({ name: 'IconStub', props: { name: String }, setup: (p) => () => h('i', { class: 'icon', 'data-name': p.name }) }),
}))
vi.mock('@/components/icons/Delete.vue', () => ({
  default: defineComponent({ name: 'DeleteIcon', setup: () => () => h('i', { class: 'delete-icon' }) }),
}))

import MessageFloatingActions from '../MessageFloatingActions.vue'

enableAutoUnmount(afterEach)

const mountActions = (props: Record<string, unknown>) => mount(MessageFloatingActions, {
  props: { message: { id: 'm1', user_id: 'them', content: [] }, style: {}, canEdit: false, canDelete: true, ...props },
  global: { stubs: { teleport: true } },
})

describe('MessageFloatingActions', () => {
  it('shows Hide on {instance} with the eye-off icon', () => {
    const del = mountActions({ deleteLabel: 'Hide on home.test', hidesOnInstance: true }).get('[data-testid="msg-action-delete"]')
    expect(del.attributes('aria-label')).toBe('Hide on home.test')
    expect(del.find('.icon[data-name="eye-off"]').exists()).toBe(true)
    expect(del.find('.delete-icon').exists()).toBe(false)
  })

  it('keeps the bin for a delete', () => {
    const del = mountActions({}).get('[data-testid="msg-action-delete"]')
    expect(del.attributes('aria-label')).toBe('message.deleteMessage')
    expect(del.find('.delete-icon').exists()).toBe(true)
  })
})
