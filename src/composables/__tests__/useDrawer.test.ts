import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useDrawer } from '../useDrawer'
import { resetLayersForTests } from '@/utils/a11y/layers'

enableAutoUnmount(afterEach)

const open = ref(false)
const mobile = ref(true)

const Shell = defineComponent({
  setup() {
    const rail = ref<HTMLElement | null>(null)
    const panel = ref<HTMLElement | null>(null)
    const backdrop = ref<HTMLElement | null>(null)
    const { toggleAttrs } = useDrawer({
      open,
      elements: () => [rail.value, panel.value],
      collapsible: () => mobile.value,
      modal: () => mobile.value,
      keep: () => [backdrop.value],
      onClose: () => (open.value = false),
      ids: ['rail', 'panel'],
    })
    return () =>
      h('div', { id: 'shell' }, [
        h('button', { id: 'toggle', ...toggleAttrs.value, onClick: () => (open.value = !open.value) }, 'Menu'),
        h('nav', { id: 'rail', ref: rail }, [h('button', { id: 'server' }, 'Server')]),
        h('nav', { id: 'panel', ref: panel }, [h('button', { id: 'channel', 'aria-current': 'page' }, 'general')]),
        h('main', { id: 'main' }, [h('button', { id: 'composer' }, 'Composer')]),
        h('div', { id: 'backdrop', ref: backdrop }),
      ])
  },
})

const $ = (id: string) => document.getElementById(id)!

function escape(target: Element) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
  open.value = false
  mobile.value = true
})

describe('useDrawer', () => {
  it('hides a closed drawer from the tab order and the accessibility tree', async () => {
    mount(Shell, { attachTo: document.body })
    await nextTick()
    for (const id of ['rail', 'panel']) {
      expect($(id).hasAttribute('inert')).toBe(true)
      expect($(id).getAttribute('aria-hidden')).toBe('true')
    }
    expect($('toggle').getAttribute('aria-expanded')).toBe('false')
    expect($('toggle').getAttribute('aria-controls')).toBe('rail panel')
  })

  it('opening on mobile makes the page inert, focuses the current item, Escape closes and returns focus', async () => {
    mount(Shell, { attachTo: document.body })
    await nextTick()
    $('toggle').focus()
    $('toggle').click()
    await nextTick()
    await nextTick()

    expect($('rail').hasAttribute('inert')).toBe(false)
    expect($('rail').hasAttribute('aria-hidden')).toBe(false)
    expect($('main').hasAttribute('inert')).toBe(true)
    expect($('toggle').hasAttribute('inert')).toBe(true)
    expect($('backdrop').hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe($('channel'))

    escape($('channel'))
    await nextTick()
    await nextTick()
    expect(open.value).toBe(false)
    expect($('main').hasAttribute('inert')).toBe(false)
    expect($('rail').hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe($('toggle'))
  })

  it('leaves a desktop column alone', async () => {
    mobile.value = false
    open.value = true
    mount(Shell, { attachTo: document.body })
    await nextTick()
    expect(document.querySelectorAll('[inert]').length).toBe(0)
    expect(document.querySelectorAll('[aria-hidden]').length).toBe(0)
  })
})
