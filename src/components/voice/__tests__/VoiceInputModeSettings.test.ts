import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

// Input mode is a native radio group in a fieldset with a legend; push to talk
// shows a recorder for its key and a labelled release-delay slider.

vi.mock('@/services/nativePtt', () => ({ armNativePtt: vi.fn(), disarmNativePtt: vi.fn() }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false, isMobileUserAgent: () => false }))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))

import VoiceInputModeSettings from '../VoiceInputModeSettings.vue'
import { resetKeybindsForTests, useKeybinds } from '@/composables/useKeybinds'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  localStorage.clear()
  resetKeybindsForTests()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetKeybindsForTests()
})

describe('VoiceInputModeSettings', () => {
  it('is a radio group in a fieldset named by its legend', async () => {
    wrapper = mount(VoiceInputModeSettings, { attachTo: document.body })
    const fieldset = wrapper.find('fieldset')
    expect(fieldset.find('legend').text()).toBe('settings.voice.inputMode')
    const radios = fieldset.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0].attributes('name')).toBe(radios[1].attributes('name'))
    expect((radios[0].element as HTMLInputElement).checked).toBe(true)
    // Each radio is named by its wrapping label and described by its hint.
    expect(radios[0].element.closest('label')?.textContent).toContain('settings.voice.voiceActivity')
    expect(document.getElementById(radios[1].attributes('aria-describedby')!)?.textContent).toBe('settings.voice.pushToTalkDesc')
  })

  it('switches to push to talk and shows its recorder and slider', async () => {
    wrapper = mount(VoiceInputModeSettings, { attachTo: document.body })
    const ptt = wrapper.find('[data-testid="input-mode-push-to-talk"]')
    ;(ptt.element as HTMLInputElement).checked = true
    await ptt.trigger('change')
    await nextTick()
    expect(useKeybinds().inputMode.value).toBe('push_to_talk')
    expect(wrapper.emitted('input-mode-change')?.[0]).toEqual(['push_to_talk'])

    expect(wrapper.find('[data-testid="keybind-recorder-push-to-talk"]').exists()).toBe(true)
    const slider = wrapper.find('[data-testid="ptt-release-delay"]')
    const label = wrapper.find(`label[for="${slider.attributes('id')}"]`)
    expect(label.text()).toContain('settings.voice.releaseDelay')
    expect(slider.attributes('aria-valuetext')).toBe('settings.voice.millisecondsLong')
  })
})
