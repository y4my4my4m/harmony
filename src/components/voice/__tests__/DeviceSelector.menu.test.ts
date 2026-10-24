import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { resetLayersForTests } from '@/utils/a11y/layers'

// The device picker is a menu button: the trigger reports expanded, the list
// is a menu of menuitemradio items with the selection checked, focus starts
// on the selected device, and a choice or Escape returns focus to the trigger.
// The capture that unlocks device labels is stopped once the list is read.

const h = vi.hoisted(() => ({ updateInputDevice: vi.fn(async () => undefined) }))
vi.mock('@/utils/mediaDevices', () => ({
  enumerateMediaDevices: async () => [
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk mic' },
    { kind: 'audioinput', deviceId: 'mic-b', label: 'Headset mic' },
  ],
}))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: { updateInputDevice: h.updateInputDevice } }))
vi.mock('@/services/VoiceSettingsService', () => ({ VoiceSettingsService: { getDevices: () => ({ inputDevice: 'mic-b' }) } }))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))

import DeviceSelector from '../DeviceSelector.vue'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => { throw new Error('denied') }), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetLayersForTests()
  document.body.innerHTML = ''
})

async function openFromKeyboard() {
  wrapper = mount(DeviceSelector, { props: { type: 'input' }, attachTo: document.body })
  const trigger = wrapper.find('button.selector-trigger')
  ;(trigger.element as HTMLElement).focus()
  await trigger.trigger('keydown', { key: 'ArrowDown' })
  await flushPromises()
  return trigger
}

describe('DeviceSelector', () => {
  it('opens a labelled menu of radio items with focus on the selected device', async () => {
    const trigger = await openFromKeyboard()
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    const menu = document.getElementById(trigger.attributes('aria-controls')!)!
    expect(menu.getAttribute('role')).toBe('menu')
    expect(menu.getAttribute('aria-label')).toBe(trigger.attributes('aria-label'))
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    expect(items.map((i) => [i.textContent?.trim(), i.getAttribute('aria-checked')])).toEqual([
      ['Desk mic', 'false'],
      ['Headset mic', 'true'],
    ])
    expect(document.activeElement).toBe(items[1])
  })

  it('returns focus to the trigger after a choice', async () => {
    const trigger = await openFromKeyboard()
    const desk = document.querySelector<HTMLElement>('[role="menuitemradio"]')!
    desk.click()
    await flushPromises()
    expect(h.updateInputDevice).toHaveBeenCalledWith('mic-a')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('closes on Escape with focus back on the trigger', async () => {
    const trigger = await openFromKeyboard()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })

  it('stops the label-unlock capture after opening', async () => {
    const tracks = [{ kind: 'audio', stop: vi.fn() }, { kind: 'video', stop: vi.fn() }]
    ;(navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }))
    await openFromKeyboard()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true })
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
  })
})
