import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { PARKED_ATTR, useRovingTabindex, type RovingOptions } from '../useRovingTabindex'

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

  // A control a media query hides has no boxes and refuses focus; moving onto it strands focus
  // and leaves the Tab stop on a control that cannot be tabbed to.
  it('skips items that render no box', () => {
    const { items } = mountList(['a', 'b', 'c'], { orientation: 'horizontal' })
    items()[1].getClientRects = () => [] as unknown as DOMRectList
    items()[0].focus()
    key(items()[0], 'ArrowRight')
    expect(document.activeElement).toBe(items()[2])
    expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    key(items()[2], 'ArrowLeft')
    expect(document.activeElement).toBe(items()[0])
  })

  it('keeps the Tab stop where it was when the item moved to refuses focus', () => {
    const { items, onActivate } = mountList(['a', 'b', 'c'])
    items()[1].focus = () => {}
    items()[0].focus()
    key(items()[0], 'ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(onActivate).not.toHaveBeenCalled()
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

/** Items that each hold a button, a text field and a slider, as message rows do. */
function mountRows(count: number, options: RovingOptions = {}) {
  const Comp = defineComponent({
    setup() {
      const list = ref<HTMLElement | null>(null)
      const { onKeydown } = useRovingTabindex(list, options)
      return () =>
        h('div', { ref: list, role: 'list', onKeydown }, Array.from({ length: count }, (_, i) =>
          h('div', { role: 'article', 'data-roving-item': '', 'data-index': String(i) }, [
            h('button', { class: 'inner' }, `button ${i}`),
            h('input', { class: 'field' }),
            h('div', { class: 'slider', role: 'slider', tabindex: '0' }),
          ])))
    },
  })
  mount(Comp, { attachTo: document.body })
  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-roving-item]'))
  const inner = (i: number, cls = 'inner') => items()[i].querySelector<HTMLElement>(`.${cls}`)!
  return { items, inner }
}

function press(target: Element, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('useRovingTabindex from controls inside items', () => {
  it('moves between items from a control inside one', () => {
    const { items, inner } = mountRows(3)
    inner(1).focus()
    press(inner(1), 'ArrowDown')
    expect(document.activeElement).toBe(items()[2])
    inner(2).focus()
    press(inner(2), 'Home')
    expect(document.activeElement).toBe(items()[0])
    expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('leaves keys to text fields and sliders inside an item', () => {
    const { inner } = mountRows(3)
    for (const cls of ['field', 'slider']) {
      const control = inner(1, cls)
      control.focus()
      for (const k of ['ArrowDown', 'Home', 'Escape']) {
        expect(press(control, k).defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(control)
      }
    }
  })

  it('returns to the item on Escape from a control inside it, and not from the item', () => {
    const { items, inner } = mountRows(3)
    inner(1).focus()
    expect(press(inner(1), 'Escape').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items()[1])
    expect(press(items()[1], 'Escape').defaultPrevented).toBe(false)
  })

  it('ignores a key a nested widget already handled', () => {
    const { inner } = mountRows(3)
    inner(1).addEventListener('keydown', (e) => e.preventDefault())
    inner(1).focus()
    press(inner(1), 'ArrowDown')
    expect(document.activeElement).toBe(inner(1))
  })

  it('calls onEnter and onContextMenu for the item itself only', () => {
    const onEnter = vi.fn()
    const onContextMenu = vi.fn()
    const { items, inner } = mountRows(2, { onEnter, onContextMenu })
    items()[0].focus()
    expect(press(items()[0], 'Enter').defaultPrevented).toBe(true)
    expect(onEnter).toHaveBeenCalledWith(items()[0], expect.any(KeyboardEvent))
    press(items()[0], 'ContextMenu')
    press(items()[0], 'F10', { shiftKey: true })
    expect(onContextMenu).toHaveBeenCalledTimes(2)
    press(items()[0], 'Enter', { shiftKey: true })
    expect(onEnter).toHaveBeenCalledTimes(1)
    inner(0).focus()
    expect(press(inner(0), 'Enter').defaultPrevented).toBe(false)
    press(inner(0), 'ContextMenu')
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(onContextMenu).toHaveBeenCalledTimes(2)
  })
})

describe('useRovingTabindex over a virtual list', () => {
  /** Renders a window of `rendered` positions out of `total`; focusIndex records the request. */
  function mountWindow(total: number, rendered: number[], extra: RovingOptions = {}) {
    const focusIndex = vi.fn()
    const onBoundary = vi.fn()
    const Comp = defineComponent({
      setup() {
        const list = ref<HTMLElement | null>(null)
        const { onKeydown } = useRovingTabindex(list, {
          loop: false,
          virtual: {
            count: () => total,
            indexOf: (el) => Number(el.dataset.pos),
            focusIndex,
          },
          onBoundary,
          ...extra,
        })
        return () => h('div', { ref: list, onKeydown }, rendered.map((pos) =>
          h('div', { 'data-roving-item': '', 'data-pos': String(pos), tabindex: '-1' }, `row ${pos}`)))
      },
    })
    mount(Comp, { attachTo: document.body })
    const row = (pos: number) => document.querySelector<HTMLElement>(`[data-pos="${pos}"]`)!
    return { focusIndex, onBoundary, row }
  }

  it('reaches positions outside the rendered window with Home, End and arrows', () => {
    const { focusIndex, row } = mountWindow(100, [40, 41, 42])
    row(41).focus()
    press(row(41), 'End')
    expect(focusIndex).toHaveBeenLastCalledWith(99)
    press(row(41), 'Home')
    expect(focusIndex).toHaveBeenLastCalledWith(0)
    press(row(42), 'ArrowDown')
    expect(focusIndex).toHaveBeenLastCalledWith(43)
  })

  it('pages by pageSize, clamped, and reports moves past either end', () => {
    const { focusIndex, onBoundary, row } = mountWindow(100, [0, 1, 98, 99], { pageSize: () => 10 })
    press(row(1), 'PageDown')
    expect(focusIndex).toHaveBeenLastCalledWith(11)
    press(row(1), 'PageUp')
    expect(focusIndex).toHaveBeenLastCalledWith(0)
    expect(onBoundary).toHaveBeenLastCalledWith(-1)
    press(row(0), 'ArrowUp')
    expect(onBoundary).toHaveBeenCalledTimes(2)
    press(row(99), 'ArrowDown')
    expect(onBoundary).toHaveBeenLastCalledWith(1)
  })

  it('leaves PageUp and PageDown alone without pageSize', () => {
    const { focusIndex, row } = mountWindow(100, [40, 41])
    expect(press(row(40), 'PageDown').defaultPrevented).toBe(false)
    expect(focusIndex).not.toHaveBeenCalled()
  })
})

describe('useRovingTabindex as a toolbar', () => {
  it('leaves Home and End to an enclosing widget when homeEnd is false', () => {
    const { items } = mountList(['a', 'b', 'c'], { orientation: 'horizontal', homeEnd: false })
    items()[1].focus()
    expect(press(items()[1], 'Home').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(items()[1])
  })

  it('leaves Ctrl+Home and Ctrl+End to the page outside a grid', () => {
    const { items } = mountList(['a', 'b', 'c'], { orientation: 'horizontal' })
    items()[1].focus()
    expect(press(items()[1], 'End', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(items()[1])
  })

  it('keeps aria-disabled items focusable with focusableDisabled', () => {
    const { items } = mountList(['a', 'b', 'c'], { orientation: 'horizontal', focusableDisabled: true }, (i) => (i === 1 ? { 'aria-disabled': 'true' } : {}))
    items()[0].focus()
    press(items()[0], 'ArrowRight')
    expect(document.activeElement).toBe(items()[1])
  })

  it('writes the tab stop of a parked item to PARKED_ATTR, not tabindex', () => {
    const { items, wrapper } = mountList(['a', 'b'], { orientation: 'horizontal' }, (i) => ({ [PARKED_ATTR]: '', tabindex: '-1', 'data-i': String(i) }))
    expect(items().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1'])
    expect(items().map((el) => el.getAttribute(PARKED_ATTR))).toEqual(['0', '-1'])
    wrapper.unmount()
  })

  it('does not count controls of a menu rendered inside the container as items', () => {
    const Comp = defineComponent({
      setup() {
        const bar = ref<HTMLElement | null>(null)
        const { onKeydown } = useRovingTabindex(bar, { itemSelector: 'button', orientation: 'horizontal' })
        return () => h('div', { ref: bar, role: 'toolbar', onKeydown }, [
          h('button', { id: 'one' }, 'one'),
          h('div', { role: 'menu' }, [h('button', { role: 'menuitem', id: 'inside' }, 'inside')]),
          h('button', { id: 'two' }, 'two'),
        ])
      },
    })
    mount(Comp, { attachTo: document.body })
    const one = document.getElementById('one')!
    one.focus()
    press(one, 'ArrowRight')
    expect(document.activeElement?.id).toBe('two')
    expect(document.getElementById('inside')!.hasAttribute('tabindex')).toBe(false)
  })
})
