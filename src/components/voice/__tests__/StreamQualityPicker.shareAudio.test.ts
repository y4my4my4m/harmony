import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'

// Go live panel: where the desktop app captures program audio natively, a Share audio switch
// replaces the browser-picker hint and persists through updateStreamQuality.

const h = vi.hoisted(() => ({ store: null as any }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('../StreamQualityOptions.vue', () => stub('StreamQualityOptions'))
vi.mock('@/services/voice/nativeStreamAudio', async () => {
  const { ref } = await import('vue')
  return {
    nativeStreamAudioSupport: ref(null),
    activeStreamAudio: ref(null),
    probeNativeStreamAudio: vi.fn(async () => ({ supported: false, reason: null })),
  }
})

import StreamQualityPicker from '../StreamQualityPicker.vue'
import { activeStreamAudio, nativeStreamAudioSupport } from '@/services/voice/nativeStreamAudio'

let wrapper: VueWrapper | null = null

function mountPicker(shareAudio: boolean, live = false) {
  h.store = reactive({
    localState: { isScreenSharing: live },
    streamSettings: { resolution: 720, frameRate: 30, audioBitrate: 128, shareAudio },
    loadStreamSettings: vi.fn(),
    updateStreamQuality: vi.fn(async () => {}),
    toggleScreenShare: vi.fn(async () => true),
    switchScreenShare: vi.fn(async () => true),
  })
  wrapper = mount(StreamQualityPicker, {
    props: { visible: true, anchor: { left: 10, top: 10, width: 10, height: 10 } },
    attachTo: document.body,
  })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  ;(nativeStreamAudioSupport as any).value = null
  ;(activeStreamAudio as any).value = null
})

const panel = () => document.body.querySelector('.sqp') as HTMLElement

describe('StreamQualityPicker share audio', () => {
  it('shows the browser hint without native capture', async () => {
    mountPicker(true)
    await flushPromises()
    expect(panel().querySelector('.sqp-audio-toggle')).toBeNull()
    expect(panel().textContent).toContain('voice.streamAudioHint')
  })

  it('offers the switch with native capture and saves a change', async () => {
    ;(nativeStreamAudioSupport as any).value = { supported: true, reason: null }
    mountPicker(true)
    await flushPromises()
    const toggle = panel().querySelector('.sqp-audio-toggle [role="switch"]') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(panel().textContent).toContain('voice.streamAudioNativeHint')
    expect(panel().textContent).not.toContain('voice.streamAudioHint')
    toggle.click()
    await flushPromises()
    expect(h.store.updateStreamQuality).toHaveBeenCalledWith({ shareAudio: false })
  })

  it('while live, names where the audio comes from', async () => {
    ;(nativeStreamAudioSupport as any).value = { supported: true, reason: null }
    ;(activeStreamAudio as any).value = { scope: 'app', app: 'Spotify', detail: 'app: pid 7 (Spotify.exe)' }
    mountPicker(true, true)
    await flushPromises()
    const line = panel().querySelector('.sqp-audio-hint') as HTMLElement
    expect(line.textContent).toContain('voice.streamAudioFromApp')
    expect(line.getAttribute('title')).toBe('app: pid 7 (Spotify.exe)')
    expect(panel().querySelector('.sqp-audio-toggle')).toBeNull()
  })

  it('reflects a saved off setting and drops the scope hint', async () => {
    ;(nativeStreamAudioSupport as any).value = { supported: true, reason: null }
    mountPicker(false)
    await flushPromises()
    const toggle = panel().querySelector('.sqp-audio-toggle [role="switch"]') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(panel().textContent).not.toContain('voice.streamAudioNativeHint')
  })

  it('live: Change source switches the share instead of stopping it', async () => {
    mountPicker(true, true)
    await flushPromises()
    const buttons = Array.from(panel().querySelectorAll('footer button')) as HTMLButtonElement[]
    expect(buttons.map(b => b.textContent?.trim())).toEqual(['voice.changeSource', 'voice.stopStreaming'])
    buttons[0].click()
    await flushPromises()
    expect(h.store.switchScreenShare).toHaveBeenCalledTimes(1)
    expect(h.store.toggleScreenShare).not.toHaveBeenCalled()
  })
})
