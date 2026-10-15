import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'

// Go live panel diagnostics in the desktop app: Test audio capture meters native capture and
// ends with a verdict; on macOS the Screen Recording permission can be reset from the panel.

const h = vi.hoisted(() => ({ store: null as any, os: 'macos' as string | null, toastError: vi.fn() }))
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: h.toastError }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => h.store }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('../StreamQualityOptions.vue', () => stub('StreamQualityOptions'))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => true }))
vi.mock('@/utils/buildInfo', () => ({ detectDesktopOs: () => h.os }))
const relaunch = vi.fn()
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }))
vi.mock('@/services/voice/nativeStreamAudio', async () => {
  const { ref, shallowRef } = await import('vue')
  class StreamAudioError extends Error {
    constructor(readonly kind: string, message: string) { super(message) }
    static from(error: unknown) {
      if (error instanceof StreamAudioError) return error
      const match = /^(unsupported|permission|failed): ?(.*)$/s.exec(String(error))
      return match ? new StreamAudioError(match[1], match[2]) : new StreamAudioError('failed', String(error))
    }
  }
  return {
    AUDIBLE_DBFS: -50,
    StreamAudioError,
    nativeStreamAudioSupport: ref({ supported: true, reason: null }),
    activeStreamAudio: ref(null),
    lastStreamSurface: shallowRef(null),
    streamAudioFailure: shallowRef(null),
    probeNativeStreamAudio: vi.fn(async () => ({ supported: true, reason: null })),
    copyStreamAudioLog: vi.fn(),
    testStreamAudio: vi.fn(),
    resetScreenRecordingPermission: vi.fn(async () => {}),
    openScreenRecordingSettings: vi.fn(async () => {}),
  }
})

import StreamQualityPicker from '../StreamQualityPicker.vue'
import * as native from '@/services/voice/nativeStreamAudio'

const testStreamAudio = native.testStreamAudio as unknown as ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null

function mountPicker(live = false) {
  h.store = reactive({
    localState: { isScreenSharing: live },
    streamSettings: { resolution: 720, frameRate: 30, audioBitrate: 128, shareAudio: true },
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
  h.os = 'macos'
  testStreamAudio.mockReset()
  ;(native.streamAudioFailure as any).value = null
  ;(native.lastStreamSurface as any).value = null
  vi.mocked(native.resetScreenRecordingPermission).mockClear()
})

const panel = () => document.body.querySelector('.sqp') as HTMLElement
const button = (label: string) =>
  Array.from(panel().querySelectorAll('button')).find(b => b.textContent?.includes(label)) as HTMLButtonElement

describe('StreamQualityPicker diagnostics', () => {
  it('meters a test of every app while not live and names the source in the verdict', async () => {
    let finish!: (value: unknown) => void
    testStreamAudio.mockImplementation((_surface, onLevel: (dbfs: number) => void) => {
      onLevel(-6)
      return new Promise(resolve => { finish = resolve })
    })
    mountPicker()
    await flushPromises()
    button('voice.testStreamAudio').click()
    await flushPromises()
    expect(testStreamAudio).toHaveBeenCalledWith(null, expect.any(Function))
    const meter = panel().querySelector('[role="meter"]') as HTMLElement
    expect(meter.getAttribute('aria-valuenow')).toBe('-6')
    expect((panel().querySelector('.sqp-meter-fill') as HTMLElement).style.width).toBe('90%')
    finish({ live: false, scope: 'app', app: 'Google Chrome', detail: 'app: pid 9 (Google Chrome)', blocks: 250, peakDbfs: -12.24 })
    await flushPromises()
    expect(panel().querySelector('[role="meter"]')).toBeNull()
    const verdict = panel().querySelector('.sqp-verdict') as HTMLElement
    expect(verdict.textContent).toContain('voice.streamAudioFlowingApp {"app":"Google Chrome","peak":"-12.2"}')
    expect(verdict.getAttribute('title')).toBe('app: pid 9 (Google Chrome)')
  })

  it('calls silence silence', async () => {
    testStreamAudio.mockResolvedValue({ live: false, scope: 'system', app: null, detail: 'system', blocks: 250, peakDbfs: -100 })
    mountPicker()
    await flushPromises()
    button('voice.testStreamAudio').click()
    await flushPromises()
    expect(panel().querySelector('.sqp-verdict.warn')?.textContent).toContain('voice.streamAudioSilenceSystem')
  })

  it('while live, tests the shared surface', async () => {
    ;(native.lastStreamSurface as any).value = { label: 'Harmony probe tone', displaySurface: 'window' }
    testStreamAudio.mockResolvedValue({ live: true, scope: 'app', app: 'Google Chrome', detail: 'app', blocks: 250, peakDbfs: -20 })
    mountPicker(true)
    await flushPromises()
    button('voice.testStreamAudio').click()
    await flushPromises()
    expect(testStreamAudio).toHaveBeenCalledWith({ label: 'Harmony probe tone', displaySurface: 'window' }, expect.any(Function))
  })

  it('a permission error explains the stale grant; reset offers a restart', async () => {
    testStreamAudio.mockRejectedValue(new native.StreamAudioError('permission', 'shareable content: declined'))
    mountPicker()
    await flushPromises()
    button('voice.testStreamAudio').click()
    await flushPromises()
    expect(panel().textContent).toContain('voice.streamAudioTestPermission')
    expect(panel().textContent).toContain('voice.streamAudioPermissionHelp')
    button('voice.resetScreenRecording').click()
    await flushPromises()
    expect(native.resetScreenRecordingPermission).toHaveBeenCalledTimes(1)
    expect(panel().textContent).toContain('voice.screenRecordingResetDone')
    button('voice.restartHarmony').click()
    await flushPromises()
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('a failed reset says why', async () => {
    vi.mocked(native.resetScreenRecordingPermission).mockRejectedValueOnce(new native.StreamAudioError('failed', 'tccutil: No such bundle identifier'))
    mountPicker()
    await flushPromises()
    button('voice.resetScreenRecording').click()
    await flushPromises()
    expect(h.toastError).toHaveBeenCalledWith('voice.screenRecordingResetFailed {"reason":"tccutil: No such bundle identifier"}')
    expect(panel().textContent).not.toContain('voice.screenRecordingResetDone')
  })

  it('outside macOS there is no permission to reset', async () => {
    h.os = 'windows'
    mountPicker()
    await flushPromises()
    expect(button('voice.testStreamAudio')).toBeTruthy()
    expect(button('voice.resetScreenRecording')).toBeUndefined()
    expect(button('voice.openScreenRecordingSettings')).toBeUndefined()
  })
})
