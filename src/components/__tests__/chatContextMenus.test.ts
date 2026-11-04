/**
 * Channel, category and thread context menus: role="menu" named after the row,
 * focus on the first item, Move up/down with their limits, focus back to the
 * row on Escape. The channel menu carries the chat header's notification
 * entries: mute and level submenus over the same store calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

const permissions = vi.hoisted(() => ({ manage: true }))
const notif = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  updateOverride: null as unknown as (...args: unknown[]) => Promise<boolean>,
  load: null as unknown as (serverId: string) => void,
  openModal: null as unknown as (serverId: string) => void,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/stores/useServerNotificationSettings', () => ({
  useServerNotificationSettingsStore: () => ({
    settingsFor: (serverId: string | null) => (serverId === 's1' ? notif.settings : null),
    updateOverride: (...args: unknown[]) => notif.updateOverride(...args),
    load: (serverId: string) => notif.load(serverId),
    openModal: (serverId: string) => notif.openModal(serverId),
  }),
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

const settingsWith = (overrides: unknown[] = []) => ({
  server_id: 's1', muted: false, muted_until: null, level: null, server_default: 'mentions',
  suppress_everyone: false, suppress_roles: false, push_notifications: true,
  overrides, channels: [], categories: [],
})

beforeEach(() => {
  permissions.manage = true
  notif.settings = settingsWith()
  notif.updateOverride = vi.fn(async () => true)
  notif.load = vi.fn()
  notif.openModal = vi.fn()
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

describe('ChannelContextMenu notification entries', () => {
  const mountMenu = () =>
    mount(ChannelContextMenu, {
      props: { isVisible: true, position: { x: 10, y: 10 }, channel, serverId: 's1', trigger: row },
      attachTo: document.body,
    })
  const submenu = (label: string) => document.body.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`)

  it('starts with Mark as read; Mute and Notification level own submenus; loads the settings', async () => {
    mountMenu()
    await flushPromises()
    expect(document.activeElement).toBe(item('mark-read'))
    for (const action of ['mute', 'notification-level']) {
      expect(item(action)?.getAttribute('aria-haspopup')).toBe('menu')
      expect(item(action)?.getAttribute('aria-expanded')).toBe('false')
    }
    expect(item('notification-settings')).not.toBeNull()
    expect(notif.load).toHaveBeenCalledWith('s1')
  })

  it('opens the level submenu with ArrowRight or a click, on its first radio; the current level is checked', async () => {
    notif.settings = settingsWith([{ channel_id: 'c1', category_id: null, level: 'all', muted: false, muted_until: null }])
    mountMenu()
    await flushPromises()
    const owner = item('notification-level')!
    owner.focus()
    press('ArrowRight')
    const radios = Array.from(submenu('notificationSettings.header.level')!.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    expect(radios).toHaveLength(4)
    expect(document.activeElement).toBe(radios[0])
    expect(owner.getAttribute('aria-expanded')).toBe('true')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    press('ArrowLeft')
    expect(document.activeElement).toBe(owner)
    expect(owner.getAttribute('aria-expanded')).toBe('false')
    owner.click()
    expect(document.activeElement).toBe(radios[0])
    press('Escape')
    expect(document.activeElement).toBe(owner)
  })

  it('a level writes the channel override the header menu writes, then closes', async () => {
    const wrapper = mountMenu()
    await flushPromises()
    item('level-none')!.click()
    await flushPromises()
    expect(notif.updateOverride).toHaveBeenCalledWith('s1', { channelId: 'c1' }, { level: 'none' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('a duration mutes the channel until then', async () => {
    const wrapper = mountMenu()
    await flushPromises()
    const before = Date.now()
    item('mute-h1')!.click()
    await flushPromises()
    const [serverId, target, changes] = (notif.updateOverride as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown, { muted: boolean; muted_until: string }]
    expect([serverId, target, changes.muted]).toEqual(['s1', { channelId: 'c1' }, true])
    const until = Date.parse(changes.muted_until) - before
    expect(until).toBeGreaterThanOrEqual(60 * 60_000 - 1000)
    expect(until).toBeLessThanOrEqual(60 * 60_000 + 1000)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('a muted channel offers Unmute and when the mute ends', async () => {
    const until = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    notif.settings = settingsWith([{ channel_id: 'c1', category_id: null, level: null, muted: true, muted_until: until }])
    mountMenu()
    await flushPromises()
    expect(item('mute')).toBeNull()
    expect(menu()?.textContent).toContain('serverRail.mute.until')
    item('unmute')!.click()
    await flushPromises()
    expect(notif.updateOverride).toHaveBeenCalledWith('s1', { channelId: 'c1' }, { muted: false })
  })

  it('a channel muted through its category unmutes the category', async () => {
    notif.settings = settingsWith([{ channel_id: null, category_id: 'k1', level: null, muted: true, muted_until: null }])
    mountMenu()
    await flushPromises()
    expect(item('unmute')?.textContent).toContain('notificationSettings.header.unmuteCategory')
    item('unmute')!.click()
    await flushPromises()
    expect(notif.updateOverride).toHaveBeenCalledWith('s1', { categoryId: 'k1' }, { muted: false })
  })

  it('opens the server\'s notification settings', async () => {
    mountMenu()
    await flushPromises()
    item('notification-settings')!.click()
    expect(notif.openModal).toHaveBeenCalledWith('s1')
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
