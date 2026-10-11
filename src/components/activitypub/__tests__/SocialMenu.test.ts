/**
 * SocialMenu.vue: the menu pattern from useMenu (first item focused, arrows, Escape back
 * to the trigger), a pointer press on the anchor leaving the toggle to the trigger's own
 * click, an outside press closing, and `initial-item` starting on the checked radio.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import SocialMenu from '../SocialMenu.vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

enableAutoUnmount(afterEach)

const Host = defineComponent({
  props: { initialItem: { type: String, default: undefined } },
  setup(props) {
    const open = ref(false)
    const reason = ref('')
    const anchor = ref<HTMLElement | null>(null)
    return () =>
      h('div', [
        h('button', { id: 'trigger', ref: anchor, onClick: () => (open.value = !open.value) }, 'More'),
        h('button', { id: 'elsewhere' }, 'Elsewhere'),
        h('span', { id: 'reason' }, reason.value),
        open.value
          ? h(SocialMenu, {
              anchor: anchor.value,
              label: 'Post visibility',
              initialItem: props.initialItem,
              onClose: (r: string) => {
                reason.value = r
                open.value = false
              },
            }, () => [
              h('button', { role: 'menuitemradio', 'aria-checked': 'false' }, 'Public'),
              h('button', { role: 'menuitemradio', 'aria-checked': 'true' }, 'Followers only'),
              h('div', { role: 'separator' }),
              h('button', { role: 'menuitemradio', 'aria-checked': 'false' }, 'Mentioned people only'),
            ])
          : null,
      ])
  },
})

const text = () => (document.activeElement as HTMLElement | null)?.textContent?.trim()
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')

function key(k: string) {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

async function open(initialItem?: string) {
  mount(Host, { props: { initialItem }, attachTo: document.body })
  const trigger = document.getElementById('trigger') as HTMLButtonElement
  trigger.focus()
  trigger.click()
  await nextTick()
  await nextTick()
  return trigger
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
})

describe('SocialMenu', () => {
  it('is a labelled menu that takes focus on its first item and moves with the arrows', async () => {
    await open()
    expect(menu()?.getAttribute('aria-label')).toBe('Post visibility')
    expect(text()).toBe('Public')
    key('ArrowDown')
    expect(text()).toBe('Followers only')
    key('End')
    expect(text()).toBe('Mentioned people only')
    key('ArrowDown')
    expect(text()).toBe('Public')
  })

  it('starts on the item matching initial-item', async () => {
    await open("[aria-checked='true']")
    await nextTick()
    expect(text()).toBe('Followers only')
  })

  it('Escape closes it and returns focus to the anchor', async () => {
    const trigger = await open()
    key('Escape')
    await nextTick()
    expect(menu()).toBeNull()
    expect(document.getElementById('reason')?.textContent).toBe('escape')
    expect(document.activeElement).toBe(trigger)
  })

  it('a press on the anchor leaves closing to its click; a press elsewhere closes', async () => {
    const trigger = await open()
    trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(menu()).not.toBeNull()
    trigger.click()
    await nextTick()
    expect(menu()).toBeNull()

    trigger.click()
    await nextTick()
    await nextTick()
    expect(menu()).not.toBeNull()
    document.getElementById('elsewhere')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(menu()).toBeNull()
    expect(document.getElementById('reason')?.textContent).toBe('outside')
  })
})
