/**
 * Channel, category and thread context menus: role="menu" named after the row,
 * focus on the first item, Move up/down with their limits, focus back to the
 * row on Escape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

const permissions = vi.hoisted(() => ({ manage: true }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: computed(() => permissions.manage),
      canManageWebhooks: computed(() => false),
      hasCurrentUserPermission: () => true,
      isLocalServer: computed(() => true),
      Permission: { CREATE_INVITE: 'CREATE_INVITE' },
    }),
  }
})

import ChannelContextMenu from '../ChannelContextMenu.vue'
import CategoryContextMenu from '../CategoryContextMenu.vue'
import ThreadContextMenu from '../threads/ThreadContextMenu.vue'

enableAutoUnmount(afterEach)

const channel = { id: 'c1', name: 'general', type: 0, category: 'k1', order: 0 } as never
const category = { id: 'k1', name: 'Text Channels', server_id: 's1', order: 0 } as never
const thread = { id: 't1', name: 'side talk', archived: false, locked: false } as never

const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const items = () => Array.from(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
const item = (action: string) => menu()?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) ?? null

function press(key: string) {
  ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

let row: HTMLButtonElement

beforeEach(() => {
  permissions.manage = true
  resetLayersForTests()
  row = document.createElement('button')
  row.textContent = 'general'
  document.body.appendChild(row)
  row.focus()
})

afterEach(() => {
  row.remove()
  document.body.innerHTML = ''
})

describe('ChannelContextMenu', () => {
  const mountMenu = (props: Record<string, unknown> = {}) =>
    mount(ChannelContextMenu, {
      props: { isVisible: true, position: { x: 10, y: 10 }, channel, trigger: row, canReorder: true, canMoveUp: false, canMoveDown: true, ...props },
      attachTo: document.body,
    })

  it('is a menu named after the channel with focus on its first item', async () => {
    mountMenu()
    await flushPromises()
    expect(menu()?.getAttribute('aria-label')).toBe('general')
    expect(items().every((el) => el.tagName === 'BUTTON')).toBe(true)
    expect(document.activeElement).toBe(items()[0])
  })

  it('disables Move up on the first channel and emits move, then close, for Move down', async () => {
    const wrapper = mountMenu()
    await flushPromises()
    expect(item('move-up')?.disabled).toBe(true)
    expect(item('move-down')?.disabled).toBe(false)
    item('move-down')!.click()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('move')).toEqual([[channel, 1]])
  })

  it('hides Move up/down without the right to reorder', async () => {
    mountMenu({ canReorder: false })
    await flushPromises()
    expect(item('move-up')).toBeNull()
  })

  it('closes on Escape; focus returns to the row', async () => {
    const wrapper = mountMenu()
    await flushPromises()
    press('Escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ isVisible: false })
    await nextTick()
    expect(document.activeElement).toBe(row)
  })
})

describe('CategoryContextMenu', () => {
  it('offers Move up/down to channel managers', async () => {
    const wrapper = mount(CategoryContextMenu, {
      props: { isVisible: true, position: { x: 0, y: 0 }, category, trigger: row, canMoveUp: true, canMoveDown: false },
      attachTo: document.body,
    })
    await flushPromises()
    expect(menu()?.getAttribute('aria-label')).toBe('Text Channels')
    expect(item('move-down')?.disabled).toBe(true)
    item('move-up')!.click()
    expect(wrapper.emitted('move')).toEqual([[category, -1]])
  })

  it('renders nothing for a member who cannot manage channels', async () => {
    permissions.manage = false
    mount(CategoryContextMenu, {
      props: { isVisible: true, position: { x: 0, y: 0 }, category },
      attachTo: document.body,
    })
    await flushPromises()
    expect(menu()).toBeNull()
  })
})

describe('ThreadContextMenu', () => {
  it('is a menu named after the thread; Tab closes it', async () => {
    const wrapper = mount(ThreadContextMenu, {
      props: { isVisible: true, position: { x: 0, y: 0 }, thread, trigger: row, serverId: 's1' },
      attachTo: document.body,
    })
    await flushPromises()
    expect(menu()?.getAttribute('aria-label')).toBe('side talk')
    expect(document.activeElement?.textContent?.trim()).toBe('chatNav.thread.leave')
    press('Tab')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
