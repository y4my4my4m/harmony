import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, Teleport } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useDialog, type InitialFocus } from '../useDialog'
import { resetLayersForTests } from '@/utils/a11y/layers'
import AppDialog from '@/components/a11y/AppDialog.vue'

enableAutoUnmount(afterEach)

const TestDialog = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    label: { type: String, default: 'Dialog' },
    withField: { type: Boolean, default: true },
    closeOnEscape: { type: Boolean, default: true },
    initialFocus: { type: [String, Object] as unknown as () => InitialFocus, default: 'auto' },
  },
  emits: ['close'],
  setup(props, { emit, slots }) {
    const el = ref<HTMLElement | null>(null)
    const { titleId } = useDialog({
      open: () => props.open,
      element: el,
      onClose: () => emit('close'),
      closeOnEscape: () => props.closeOnEscape,
      initialFocus: () => props.initialFocus,
    })
    return () =>
      h(Teleport, { to: 'body' }, props.open
        ? [h('div', { ref: el, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', 'data-testid': props.label }, [
            h('h2', { id: titleId }, props.label),
            props.withField ? h('input', { 'data-testid': `${props.label}-field` }) : null,
            h('button', { 'data-testid': `${props.label}-first` }, 'first'),
            slots.default?.(),
            h('button', { 'data-testid': `${props.label}-last` }, 'last'),
          ])]
        : [])
  },
})

function escape(target: EventTarget) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

function tab(shift = false) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
  return event
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
})

describe('useDialog', () => {
  it('moves focus to the first field, makes the page inert and restores focus on close', async () => {
    const page = document.createElement('div')
    page.id = 'app'
    page.innerHTML = '<button id="opener">open</button>'
    document.body.append(page)
    const opener = document.getElementById('opener') as HTMLButtonElement
    opener.focus()

    const wrapper = mount(TestDialog, { props: { open: false, label: 'one' } })
    await wrapper.setProps({ open: true })
    await nextTick()

    expect(document.activeElement).toBe(q('one-field'))
    expect(page.hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ open: false })
    await nextTick()
    expect(page.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
  })

  it('focuses the dialog itself when it has no field', async () => {
    const wrapper = mount(TestDialog, { props: { open: false, label: 'plain', withField: false } })
    await wrapper.setProps({ open: true })
    await nextTick()
    expect(document.activeElement).toBe(q('plain'))
  })

  it('honours an initialFocus selector', async () => {
    const wrapper = mount(TestDialog, { props: { open: false, label: 'sel', initialFocus: '[data-testid="sel-last"]' } })
    await wrapper.setProps({ open: true })
    await nextTick()
    expect(document.activeElement).toBe(q('sel-last'))
  })

  it('wraps Tab and Shift+Tab inside the dialog', async () => {
    const wrapper = mount(TestDialog, { props: { open: false, label: 'trap' } })
    await wrapper.setProps({ open: true })
    await nextTick()
    q('trap-last').focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('trap-field'))
    expect(tab(true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q('trap-last'))
    q('trap-first').focus()
    expect(tab().defaultPrevented).toBe(false)
  })

  it('closes only the topmost of two stacked dialogs on Escape and returns focus into the lower one', async () => {
    const lower = mount(TestDialog, { props: { open: false, label: 'lower' } })
    await lower.setProps({ open: true })
    await nextTick()
    q('lower-first').focus()

    const upper = mount(TestDialog, { props: { open: false, label: 'upper' } })
    await upper.setProps({ open: true })
    await nextTick()
    expect(document.activeElement).toBe(q('upper-field'))
    expect(q('lower').closest('[inert]')).not.toBeNull()

    escape(document.activeElement!)
    expect(upper.emitted('close')).toHaveLength(1)
    expect(lower.emitted('close')).toBeUndefined()

    await upper.setProps({ open: false })
    await nextTick()
    expect(q('lower').closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(q('lower-first'))

    escape(document.activeElement!)
    expect(lower.emitted('close')).toHaveLength(1)
  })

  it('swallows Escape when closeOnEscape is false', async () => {
    const outer = mount(TestDialog, { props: { open: false, label: 'outer' } })
    await outer.setProps({ open: true })
    await nextTick()
    const inner = mount(TestDialog, { props: { open: false, label: 'inner', closeOnEscape: false } })
    await inner.setProps({ open: true })
    await nextTick()
    escape(document.activeElement!)
    expect(inner.emitted('close')).toBeUndefined()
    expect(outer.emitted('close')).toBeUndefined()
  })

  it('restores focus when the dialog unmounts while open', async () => {
    document.body.innerHTML = '<button id="opener">open</button>'
    const opener = document.getElementById('opener') as HTMLButtonElement
    opener.focus()
    const wrapper = mount(TestDialog, { props: { open: true, label: 'mounted' } })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(q('mounted-field'))
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
  })
})

describe('AppDialog', () => {
  it('renders a labelled modal dialog and reports Escape and overlay clicks', async () => {
    const wrapper = mount(AppDialog, {
      props: { open: false, label: 'Pinned messages' },
      attrs: { class: 'pinned-popup' },
      slots: { default: () => h('button', 'inside') },
      attachTo: document.body,
    })
    await wrapper.setProps({ open: true })
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Pinned messages')
    expect(dialog.classList.contains('pinned-popup')).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)

    escape(document.activeElement!)
    expect(wrapper.emitted('close')?.[0]).toEqual(['escape'])

    const overlay = document.querySelector<HTMLElement>('[data-dialog-overlay]')!
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')?.[1]).toEqual(['overlay'])
  })

  it('labels the dialog by the slot heading when no label is given', async () => {
    mount(AppDialog, {
      props: { open: true },
      slots: { default: ({ titleId }: { titleId: string }) => h('h2', { id: titleId }, 'Edit list') },
      attachTo: document.body,
    })
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const heading = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(heading?.textContent).toBe('Edit list')
  })
})
