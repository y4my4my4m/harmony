import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import IconButton from '../IconButton.vue'
import AppTimestamp from '../AppTimestamp.vue'
import VisuallyHidden from '../VisuallyHidden.vue'
import SkipLink from '../SkipLink.vue'
import AppToolbar from '../AppToolbar.vue'
import { composedTitle, pushViewTitle, setRouteTitle, setTitleInstance, setTitleUnread } from '@/utils/a11y/documentTitle'
import { toastRole } from '@/utils/a11y/toastRole'
import { patchRoleButtons, roleButtonKeyActivation } from '@/utils/a11y/roleButtons'

vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', props: { name: String }, render: () => h('svg') }) }
})

enableAutoUnmount(afterEach)

describe('IconButton', () => {
  it('is named by its label with the icon hidden', () => {
    const wrapper = mount(IconButton, { props: { label: 'Close', icon: 'x' } })
    const button = wrapper.get('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Close')
    expect(button.attributes('title')).toBe('Close')
    expect(wrapper.get('.icon-button__icon').attributes('aria-hidden')).toBe('true')
    expect(button.attributes('aria-pressed')).toBeUndefined()
  })

  it('renders pressed and disclosure state', () => {
    const wrapper = mount(IconButton, {
      props: { label: 'Members', pressed: true, expanded: false, controls: 'panel', haspopup: 'menu', hideTooltip: true },
    })
    const button = wrapper.get('button')
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-expanded')).toBe('false')
    expect(button.attributes('aria-controls')).toBe('panel')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(button.attributes('title')).toBeUndefined()
  })
})

describe('AppTimestamp', () => {
  it('puts the full date in a <time datetime> and hides the short text from screen readers', () => {
    const wrapper = mount(AppTimestamp, { props: { value: '2026-10-11T10:58:00Z', short: '5m' } })
    const time = wrapper.get('time')
    expect(time.attributes('datetime')).toBe('2026-10-11T10:58:00.000Z')
    expect(wrapper.get('[aria-hidden="true"]').text()).toBe('5m')
    const full = wrapper.get('.sr-only').text()
    expect(full).toMatch(/2026/)
    expect(time.attributes('title')).toBe(full)
  })

  it('formats relative times', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
    const wrapper = mount(AppTimestamp, { props: { value: '2026-10-11T11:55:00Z', format: 'relative' } })
    expect(wrapper.get('[aria-hidden="true"]').text()).toMatch(/5 minutes ago/)
    vi.useRealTimers()
  })
})

describe('VisuallyHidden', () => {
  it('uses the global sr-only class', () => {
    const wrapper = mount(VisuallyHidden, { slots: { default: () => 'Delete' } })
    expect(wrapper.classes()).toContain('sr-only')
    expect(mount(VisuallyHidden, { props: { focusable: true, as: 'a' } }).classes()).toContain('sr-only-focusable')
  })
})

describe('SkipLink', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="main-content"></main>'
  })

  it('moves focus to the main landmark', async () => {
    const wrapper = mount(SkipLink, { attachTo: document.body, global: { mocks: { $t: (k: string) => k } } })
    await wrapper.get('a').trigger('click')
    const main = document.getElementById('main-content')!
    expect(document.activeElement).toBe(main)
    expect(main.getAttribute('tabindex')).toBe('-1')
  })
})

describe('documentTitle', () => {
  it('composes unread count, view and instance name', () => {
    setTitleInstance('Harmony Test')
    setTitleUnread(0)
    setRouteTitle('Settings')
    expect(composedTitle.value).toBe('Settings – Harmony Test')
    const remove = pushViewTitle(() => '#general – Hub')
    setTitleUnread(3)
    expect(composedTitle.value).toBe('(3) #general – Hub – Harmony Test')
    expect(document.title).toBe('(3) #general – Hub – Harmony Test')
    remove()
    setRouteTitle('')
    setTitleUnread(0)
    expect(composedTitle.value).toBe('Harmony Test')
  })
})

describe('toastRole', () => {
  it('interrupts for errors and warnings only', () => {
    expect(toastRole('error')).toBe('alert')
    expect(toastRole('warning')).toBe('alert')
    expect(toastRole('success')).toBe('status')
    expect(toastRole('info')).toBe('status')
    expect(toastRole(undefined)).toBe('status')
  })
})

describe('roleButtons', () => {
  it('gives role=button divs a tab stop, a translated name and key activation', () => {
    document.body.innerHTML = '<div class="modal"><div role="button" aria-label="zoom in button"></div></div>'
    const modal = document.querySelector('.modal')!
    const button = modal.querySelector<HTMLElement>('[role="button"]')!
    patchRoleButtons(modal, (original) => (original === 'zoom in button' ? 'Zoom in' : undefined))
    expect(button.getAttribute('tabindex')).toBe('0')
    expect(button.getAttribute('aria-label')).toBe('Zoom in')
    patchRoleButtons(modal, (original) => (original === 'zoom in button' ? 'Vergrößern' : undefined))
    expect(button.getAttribute('aria-label')).toBe('Vergrößern')

    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    const handler = roleButtonKeyActivation(() => modal)
    document.addEventListener('keydown', handler)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    expect(clicked).toHaveBeenCalledTimes(2)
    document.removeEventListener('keydown', handler)
  })
})


describe('AppToolbar', () => {
  const Host = (homeEnd = true) => defineComponent({
    setup() {
      const extra = ref(false)
      return { extra }
    },
    render() {
      return h(AppToolbar, { label: 'Message actions', homeEnd }, () => [
        h('button', { id: 'react' }, 'React'),
        h('button', { id: 'reply', 'aria-disabled': 'true' }, 'Reply'),
        h('button', { id: 'more' }, 'More'),
        this.extra ? h('button', { id: 'extra' }, 'Extra') : null,
      ])
    },
  })
  const press = (id: string, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    document.getElementById(id)!.dispatchEvent(event)
    return event
  }
  const stops = () => Array.from(document.querySelectorAll('[role="toolbar"] button')).map((b) => b.getAttribute('tabindex'))

  it('is a labelled toolbar with one Tab stop', () => {
    const wrapper = mount(Host(), { attachTo: document.body })
    expect(wrapper.get('[role="toolbar"]').attributes('aria-label')).toBe('Message actions')
    expect(stops()).toEqual(['0', '-1', '-1'])
  })

  it('moves with Left and Right, wraps, and keeps aria-disabled controls focusable', () => {
    mount(Host(), { attachTo: document.body })
    document.getElementById('react')!.focus()
    press('react', 'ArrowRight')
    expect(document.activeElement?.id).toBe('reply')
    press('reply', 'ArrowRight')
    press('more', 'ArrowRight')
    expect(document.activeElement?.id).toBe('react')
    press('react', 'ArrowLeft')
    expect(document.activeElement?.id).toBe('more')
    expect(stops()).toEqual(['-1', '-1', '0'])
    expect(press('more', 'ArrowDown').defaultPrevented).toBe(false)
  })

  it('goes to the ends with Home and End, or leaves them when homeEnd is false', () => {
    mount(Host(), { attachTo: document.body })
    document.getElementById('react')!.focus()
    press('react', 'End')
    expect(document.activeElement?.id).toBe('more')
    press('more', 'Home')
    expect(document.activeElement?.id).toBe('react')
    document.body.innerHTML = ''
    mount(Host(false), { attachTo: document.body })
    document.getElementById('react')!.focus()
    expect(press('react', 'End').defaultPrevented).toBe(false)
    expect(document.activeElement?.id).toBe('react')
  })

  it('moves the Tab stop off a control that stops rendering when the viewport resizes', async () => {
    mount(Host(), { attachTo: document.body })
    document.getElementById('more')!.focus()
    document.getElementById('more')!.blur()
    expect(stops()).toEqual(['-1', '-1', '0'])
    document.getElementById('more')!.getClientRects = () => [] as unknown as DOMRectList
    window.dispatchEvent(new Event('resize'))
    await Promise.resolve()
    expect(stops()).toEqual(['0', '-1', '0'])
  })

  it('gives the Tab stop to a control focused by pointer and to the toolbar\'s new controls', async () => {
    const wrapper = mount(Host(), { attachTo: document.body })
    document.getElementById('more')!.focus()
    expect(stops()).toEqual(['-1', '-1', '0'])
    ;(wrapper.vm as unknown as { extra: boolean }).extra = true
    await nextTick()
    await Promise.resolve()
    expect(stops()).toEqual(['-1', '-1', '0', '-1'])
  })
})
