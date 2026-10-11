import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

// The shortcut recorder: a labelled readonly input that records only after
// Enter/Space/click, ignores navigation keys, announces what happened, and
// leaves a conflicting combination unapplied until the user confirms it.
// Settings › Keybinds lists every voice shortcut with an enable switch.

const polite = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }) }))
vi.mock('@/services/nativePtt', () => ({ armNativePtt: vi.fn(), disarmNativePtt: vi.fn() }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false, isMobileUserAgent: () => false }))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))
vi.mock('@/components/a11y/KeyboardNavigationHelp.vue', () => ({ __esModule: true, default: { name: 'KeyboardNavigationHelp', render: () => null } }))

import KeybindRecorder from '../KeybindRecorder.vue'
import KeybindSettings from '@/components/settings/user/KeybindSettings.vue'
import { resetKeybindsForTests, useKeybinds } from '@/composables/useKeybinds'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('harmony-keybinds', JSON.stringify({ defaults: 2, keybinds: {} }))
  resetKeybindsForTests()
  polite.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetKeybindsForTests()
})

function press(el: Element, code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

async function recorder(action: 'toggle-mute' | 'push-to-talk' = 'toggle-mute') {
  wrapper = mount(KeybindRecorder, { props: { action, name: 'Toggle mute' }, attachTo: document.body })
  await nextTick()
  return wrapper.find('input')
}

describe('KeybindRecorder', () => {
  it('is a labelled readonly text input showing the current binding', async () => {
    const input = await recorder()
    expect(input.attributes('readonly')).toBeDefined()
    expect(input.attributes('type')).toBe('text')
    expect(input.attributes('aria-label')).toBe('settings.keybinds.shortcutFor')
    expect((input.element as HTMLInputElement).value).toBe('Ctrl + Shift + M')
    const hint = document.getElementById(input.attributes('aria-describedby')!.split(' ')[0])
    expect(hint?.textContent).toBe('settings.keybinds.recorderHint')
  })

  it('does not record until started, then records the next combination', async () => {
    const input = await recorder()
    press(input.element, 'KeyK', { key: 'k' })
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')

    press(input.element, 'Enter', { key: 'Enter' })
    await nextTick()
    expect(polite).toHaveBeenCalledWith('settings.keybinds.recordingStarted', { dedupeMs: 0 })
    expect((input.element as HTMLInputElement).value).toBe('settings.keybinds.pressKeys')

    const event = press(input.element, 'KeyK', { key: 'K', ctrlKey: true, altKey: true })
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Alt + K')
    expect(polite).toHaveBeenLastCalledWith('settings.keybinds.set', { dedupeMs: 0 })
  })

  it('ignores Tab, plain Enter, Space and arrows while recording; modifiers alone wait', async () => {
    const input = await recorder()
    press(input.element, 'Enter', { key: 'Enter' })
    const tab = press(input.element, 'Tab', { key: 'Tab' })
    expect(tab.defaultPrevented).toBe(false)
    for (const [code, key] of [['Enter', 'Enter'], ['Space', ' '], ['ArrowDown', 'ArrowDown'], ['ShiftLeft', 'Shift']]) {
      press(input.element, code, { key })
    }
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
    expect(polite).toHaveBeenCalledWith('settings.keybinds.reservedKey', { key: 'keybind-reserved' })

    press(input.element, 'Space', { key: ' ', ctrlKey: true })
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Space')
  })

  it('cancels on Escape without letting it close the surrounding dialog', async () => {
    const input = await recorder()
    press(input.element, 'Enter', { key: 'Enter' })
    const onWindow = vi.fn()
    window.addEventListener('keydown', onWindow)
    const esc = press(input.element, 'Escape', { key: 'Escape' })
    window.removeEventListener('keydown', onWindow)
    expect(esc.defaultPrevented).toBe(true)
    expect(onWindow).not.toHaveBeenCalled()
    expect(polite).toHaveBeenLastCalledWith('settings.keybinds.unchanged', { dedupeMs: 0 })
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
  })

  it('holds global keybinds off while recording', async () => {
    const input = await recorder()
    const kb = useKeybinds()
    kb.activateContext('voice-connected')
    kb.setupListeners()
    const handler = vi.fn()
    kb.registerHandler('toggle-deafen', handler)
    press(input.element, 'Enter', { key: 'Enter' })
    press(document.body, 'KeyD', { key: 'D', ctrlKey: true, shiftKey: true })
    expect(handler).not.toHaveBeenCalled()
    kb.cleanupListeners()
  })

  it('shows a conflict in an alert region and applies it only on Assign anyway', async () => {
    const input = await recorder()
    const alert = wrapper!.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toBe('')

    press(input.element, 'Enter', { key: 'Enter' })
    press(input.element, 'KeyD', { key: 'D', ctrlKey: true, shiftKey: true })
    await nextTick()
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
    expect(alert.text()).toContain('settings.keybinds.conflict')
    expect(input.attributes('aria-invalid')).toBe('true')

    const [assign, cancel] = alert.findAll('button')
    expect(assign.text()).toBe('settings.keybinds.assignAnyway')
    expect(cancel.text()).toBe('common.cancel')
    await assign.trigger('click')
    await flushPromises()
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + D')
    expect(alert.text()).toBe('')
    expect(document.activeElement).toBe(input.element)
  })

  it('leaves the binding on Cancel', async () => {
    const input = await recorder()
    press(input.element, 'Enter', { key: 'Enter' })
    press(input.element, 'KeyD', { key: 'D', ctrlKey: true, shiftKey: true })
    await nextTick()
    await wrapper!.findAll('[role="alert"] button')[1].trigger('click')
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
    expect(polite).toHaveBeenLastCalledWith('settings.keybinds.unchanged', { dedupeMs: 0 })
  })
})

describe('KeybindSettings', () => {
  it('lists each voice shortcut with a named switch, recorder and reset', async () => {
    wrapper = mount(KeybindSettings, { props: { loading: false }, attachTo: document.body })
    await nextTick()
    const rows = wrapper.findAll('li.keybind-item')
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      const toggle = row.find('[role="switch"]')
      expect(toggle.attributes('aria-label')).toBe('settings.keybinds.enabledFor')
      expect(row.find('input[readonly]').exists()).toBe(true)
      expect(row.find('button.reset-single-btn').attributes('aria-label')).toBe('settings.keybinds.resetOne')
    }
  })

  it('turns a shortcut off from its switch', async () => {
    wrapper = mount(KeybindSettings, { props: { loading: false }, attachTo: document.body })
    await nextTick()
    const toggle = wrapper.find('[data-testid="keybind-toggle-toggle-mute"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(useKeybinds().getKeybind('toggle-mute')?.enabled).toBe(false)
    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('offers the chorded pair to a user on single-key mute and deafen', async () => {
    localStorage.setItem('harmony-keybinds', JSON.stringify({ keybinds: {} }))
    resetKeybindsForTests()
    wrapper = mount(KeybindSettings, { props: { loading: false }, attachTo: document.body })
    await nextTick()
    const note = wrapper.find('[data-testid="keybinds-single-key-note"]')
    expect(note.exists()).toBe(true)
    await wrapper.find('[data-testid="keybinds-use-chorded"]').trigger('click')
    expect(useKeybinds().getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
    expect(useKeybinds().getKeybindDisplay('toggle-deafen')).toBe('Ctrl + Shift + D')
    expect(wrapper.find('[data-testid="keybinds-single-key-note"]').exists()).toBe(false)
  })
})
