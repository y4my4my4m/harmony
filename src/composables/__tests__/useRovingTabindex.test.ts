import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useRovingTabindex, type RovingOptions } from '../useRovingTabindex'

enableAutoUnmount(afterEach)

function mountList(labels: string[], options: RovingOptions = {}, attrs: (i: number) => Record<string, string> = () => ({})) {
  const onActivate = vi.fn()
  const Comp = defineComponent({
    setup() {
      const list = ref<HTMLElement | null>(null)
      const { onKeydown } = useRovingTabindex(list, { onActivate, ...options })
      return () =>
        h('div', { ref: list, role: 'listbox', onKeydown }, labels.map((label, i) =>
          h('div', { role: 'option', 'data-roving-item': '', ...attrs(i) }, label)))
    },
  })
  const wrapper = mount(Comp, { attachTo: document.body })
  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-roving-item]'))
  return { wrapper, items, onActivate }
}

function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
}

describe('useRovingTabindex', () => {
  it('keeps one tab stop, on the selected item', () => {
    const { items } = mountList(['a', 'b', 'c'], {}, (i) => (i === 1 ? { 'aria-selected': 'true' } : {}))
    expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('moves with arrows, wraps, and jumps with Home/End', () => {
    const { items, onActivate } = mountList(['a', 'b', 'c'])
    items()[0].focus()
    key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    expect(items()[1].getAttribute('tabindex')).toBe('0')
    expect(items()[0].getAttribute('tabindex')).toBe('-1')
    key(items()[1], 'End')
    expect(document.activeElement).toBe(items()[2])
    key(items()[2], 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    key(items()[0], 'ArrowUp')
    expect(document.activeElement).toBe(items()[2])
    key(items()[2], 'Home')
    expect(document.activeElement).toBe(items()[0])
    expect(onActivate).toHaveBeenCalled()
  })

  it('skips disabled items', () => {
    const { items } = mountList(['a', 'b', 'c'], {}, (i) => (i === 1 ? { 'aria-disabled': 'true' } : {}))
    items()[0].focus()
    key(items()[0], 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('c')
  })

  it('moves by rows in a grid and clamps at the edges', () => {
    const { items } = mountList(['1', '2', '3', '4', '5', '6'], { orientation: 'grid', columns: 3 })
    items()[0].focus()
    key(items()[0], 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('4')
    key(document.activeElement!, 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('5')
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('5')
    key(document.activeElement!, 'Home')
    expect(document.activeElement?.textContent).toBe('4')
    key(document.activeElement!, 'End', { ctrlKey: true })
    expect(document.activeElement?.textContent).toBe('6')
  })

  it('ignores the cross axis in a horizontal list', () => {
    const { items } = mountList(['a', 'b'], { orientation: 'horizontal' })
    items()[0].focus()
    key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    key(items()[0], 'ArrowRight')
    expect(document.activeElement).toBe(items()[1])
  })

  it('jumps by typed prefix when typeahead is on', () => {
    const { items } = mountList(['Apple', 'Banana', 'Blueberry', 'Cherry'], { typeahead: true })
    items()[0].focus()
    key(items()[0], 'b')
    expect(document.activeElement?.textContent).toBe('Banana')
    key(document.activeElement!, 'l')
    expect(document.activeElement?.textContent).toBe('Blueberry')
  })
})
