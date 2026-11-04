import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import AppMenu from '@/components/a11y/AppMenu.vue'
import { isContextMenuKey, toggleSubmenu, useMenuButton } from '../useMenu'
import { resetLayersForTests } from '@/utils/a11y/layers'

enableAutoUnmount(afterEach)

const Host = defineComponent({
  setup() {
    const open = ref(false)
    const reason = ref('')
    const picked = ref('')
    const { triggerAttrs, onTriggerKeydown, menuId, initialFocus } = useMenuButton(open)
    return () =>
      h('div', [
        h('button', { id: 'trigger', ...triggerAttrs.value, onClick: () => (open.value = true), onKeydown: onTriggerKeydown }, 'More'),
        h('span', { id: 'reason' }, reason.value),
        h('span', { id: 'picked' }, picked.value),
        open.value
          ? h(AppMenu, {
              id: menuId,
              label: 'Server options',
              initialFocus: initialFocus.value,
              onClose: (r: string) => {
                reason.value = r
                open.value = false
              },
            }, () => [
              h('button', { role: 'menuitem', onClick: () => { picked.value = 'invite'; open.value = false } }, 'Invite people'),
              h('button', { role: 'menuitem', disabled: true }, 'Disabled'),
              h('div', { class: 'menu-sub', role: 'none' }, [
                h('button', { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: (e: MouseEvent) => toggleSubmenu(e.currentTarget as HTMLElement) }, 'Mute'),
                h('div', { role: 'menu', 'aria-label': 'Mute' }, [
                  h('button', { role: 'menuitem' }, 'For 1 hour'),
                  h('button', { role: 'menuitem' }, 'Until I turn it back on'),
                ]),
              ]),
              h('div', { class: 'menu-sub', role: 'none' }, [
                h('button', { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: (e: MouseEvent) => toggleSubmenu(e.currentTarget as HTMLElement) }, 'Notify'),
                h('div', { role: 'menu', 'aria-label': 'Notify' }, [
                  h('button', { role: 'menuitemradio', 'aria-checked': 'true' }, 'All'),
                  h('button', { role: 'menuitemradio', 'aria-checked': 'false' }, 'Nothing'),
                ]),
              ]),
              h('div', { role: 'menuitemcheckbox', 'aria-checked': 'false', tabindex: '-1', onClick: () => (picked.value = 'check') }, 'Leave'),
            ])
          : null,
      ])
  },
})

function key(k: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
}

const text = () => (document.activeElement as HTMLElement | null)?.textContent?.trim()

async function openWith(keyName?: string) {
  const wrapper = mount(Host, { attachTo: document.body })
  const trigger = document.getElementById('trigger') as HTMLButtonElement
  trigger.focus()
  if (keyName) key(keyName)
  else trigger.click()
  await nextTick()
  await nextTick()
  return { wrapper, trigger }
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
})

describe('AppMenu / useMenu', () => {
  it('reports state on the trigger and focuses the first item', async () => {
    const { trigger } = await openWith()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = document.querySelector('[role="menu"]')!
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)
    expect(menu.getAttribute('aria-label')).toBe('Server options')
    expect(text()).toBe('Invite people')
  })

  it('ArrowUp on the trigger opens with the last item focused', async () => {
    await openWith('ArrowUp')
    expect(text()).toBe('Leave')
  })

  it('moves with arrows, skips disabled items, wraps, Home/End', async () => {
    await openWith()
    key('ArrowDown')
    expect(text()).toContain('Mute')
    key('ArrowDown')
    expect(text()).toContain('Notify')
    key('ArrowDown')
    expect(text()).toBe('Leave')
    key('ArrowDown')
    expect(text()).toBe('Invite people')
    key('End')
    expect(text()).toBe('Leave')
    key('Home')
    expect(text()).toBe('Invite people')
  })

  it('opens a submenu with ArrowRight and closes it with ArrowLeft or Escape', async () => {
    await openWith()
    key('ArrowDown')
    key('ArrowRight')
    expect(text()).toBe('For 1 hour')
    expect(document.querySelector('.menu-sub')!.classList.contains('open')).toBe(true)
    key('ArrowLeft')
    expect(text()).toContain('Mute')
    key('ArrowRight')
    key('Escape')
    expect(text()).toContain('Mute')
    expect(document.querySelector('[role="menu"][aria-label="Server options"]')).not.toBeNull()
  })

  it('opens a submenu from its owner\'s click (Enter, Space, a tap) and closes it on the next', async () => {
    await openWith()
    key('ArrowDown')
    const mute = document.activeElement as HTMLElement
    mute.click()
    expect(text()).toBe('For 1 hour')
    expect(mute.getAttribute('aria-expanded')).toBe('true')
    expect(mute.parentElement!.classList.contains('open')).toBe(true)
    key('ArrowDown')
    expect(text()).toBe('Until I turn it back on')
    key('ArrowDown')
    expect(text()).toBe('For 1 hour')
    mute.click()
    expect(document.activeElement).toBe(mute)
    expect(mute.getAttribute('aria-expanded')).toBe('false')
    expect(mute.parentElement!.classList.contains('open')).toBe(false)
  })

  it('opening one submenu closes another of the same menu', async () => {
    await openWith()
    const [mute, notify] = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [aria-haspopup="menu"]'))
    mute.click()
    notify.click()
    expect(text()).toBe('All')
    expect(mute.getAttribute('aria-expanded')).toBe('false')
    expect(mute.parentElement!.classList.contains('open')).toBe(false)
    expect(notify.getAttribute('aria-expanded')).toBe('true')
    key('ArrowLeft')
    expect(document.activeElement).toBe(notify)
    expect(notify.getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape closes and returns focus to the trigger', async () => {
    const { trigger } = await openWith()
    key('Escape')
    await nextTick()
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.getElementById('reason')!.textContent).toBe('escape')
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('Tab closes the menu', async () => {
    await openWith()
    key('Tab')
    await nextTick()
    expect(document.getElementById('reason')!.textContent).toBe('tab')
  })

  it('jumps by typed letters and activates non-button items with Enter', async () => {
    await openWith()
    key('l')
    expect(text()).toBe('Leave')
    key('Enter')
    await nextTick()
    expect(document.getElementById('picked')!.textContent).toBe('check')
  })

  it('returns focus to the trigger after an item closes the menu', async () => {
    const { trigger } = await openWith()
    ;(document.activeElement as HTMLElement).click()
    await nextTick()
    await nextTick()
    expect(document.getElementById('picked')!.textContent).toBe('invite')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('isContextMenuKey', () => {
  it('accepts the ContextMenu key and Shift+F10', () => {
    expect(isContextMenuKey(new KeyboardEvent('keydown', { key: 'ContextMenu' }))).toBe(true)
    expect(isContextMenuKey(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true }))).toBe(true)
    expect(isContextMenuKey(new KeyboardEvent('keydown', { key: 'F10' }))).toBe(false)
  })
})
