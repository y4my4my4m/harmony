/**
 * The message menu is a WAI-ARIA menu on AppMenu: named, items as menuitems,
 * arrow keys between them, Escape closing with focus back on the element it was
 * opened from, and quick reactions named by their emoji in words.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ getMessageReactions: () => [] }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ topEmojisForContextMenu: ref([]), hasFrequentEmojis: ref(false), recordEmojiUsage: vi.fn() }),
}))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({ useServerPermissions: () => ({ canPinMessages: ref(false) }) }))
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canPinMessages: ref(false), canManageMessages: ref(false), canCreateThreads: ref(true) }),
}))
vi.mock('@/composables/useDeveloperTools', () => ({ useDeveloperTools: () => ({ developerToolsEnabled: ref(false) }) }))
vi.mock('@/composables/usePinActions', () => ({ usePinActions: () => ({ setPinned: vi.fn() }) }))
vi.mock('@/services/privateMedia', () => ({ resolveMediaPartUrl: vi.fn(async () => null) }))
vi.mock('@/utils/downloadMedia', () => ({ downloadMediaFromUrl: vi.fn(), filenameFromUrl: vi.fn() }))

import MessageContextMenu from '../MessageContextMenu.vue'

const message = { id: 'm1', user_id: 'them', content: [{ type: 'text', text: 'hi' }], created_at: new Date() } as any

let wrapper: VueWrapper | null = null
let trigger: HTMLButtonElement

async function openMenu() {
  trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  wrapper = mount(MessageContextMenu, {
    props: { isVisible: true, position: { x: 10, y: 10 }, message, currentUserId: 'me', canDelete: true, trigger },
    global: { mocks: { $t: (key: string) => key }, stubs: { Icon: true } },
    attachTo: document.body,
  })
  await nextTick()
  await nextTick()
  return document.querySelector<HTMLElement>('[role="menu"]')!
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  trigger?.remove()
})

const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('MessageContextMenu for keyboard and screen-reader users', () => {
  it('is a named menu of menuitems that takes focus', async () => {
    const menu = await openMenu()
    expect(menu.getAttribute('aria-label')).toBe('messageA11y.menu.label')
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
    expect(items.length).toBeGreaterThan(5)
    expect(items.every((item) => item.tagName === 'BUTTON')).toBe(true)
    expect(document.activeElement).toBe(items[0])
    expect(items[0].getAttribute('aria-label')).toBe('messageA11y.menu.reactWith')
    expect(menu.querySelector('.destructive-item')?.textContent).toContain('message.deleteMessage')
  })

  it('moves with the arrow keys and closes on Escape', async () => {
    const menu = await openMenu()
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    press('ArrowDown')
    expect(document.activeElement).toBe(items[1])
    press('End')
    expect(document.activeElement).toBe(items[items.length - 1])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper!.emitted('close')).toBeTruthy()
  })

  it('returns focus to its trigger when it closes', async () => {
    await openMenu()
    await wrapper!.setProps({ isVisible: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
  })
})
