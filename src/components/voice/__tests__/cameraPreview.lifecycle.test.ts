/**
 * Camera preview of Settings > Voice & video (VoiceSettingsInline) and of the call's settings
 * panel (VoiceSettingsPanel). The preview starts when a camera is selected; a capture that
 * resolves after the view closed, or after a later selection, is stopped instead of left live.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, te: () => false }),
}))
vi.mock('@/utils/mediaDevices', () => ({
  enumerateMediaDevices: vi.fn(async () => [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic', groupId: '' },
    { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers', groupId: '' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam', groupId: '' },
    { kind: 'videoinput', deviceId: 'cam-2', label: 'Document camera', groupId: '' },
  ]),
}))
vi.mock('@/services/webrtcManager', () => ({
  webrtcManager: {
    updateVideoDevice: vi.fn(),
    updateAudioDevice: vi.fn(),
    setOutputDevice: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
  },
}))
vi.mock('@/utils/userScopedStorage', () => {
  const store = new Map<string, string>()
  return {
    userStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    },
  }
})

import VoiceSettingsInline from '@/components/settings/user/VoiceSettingsInline.vue'
import VoiceSettingsPanel from '@/components/voice/VoiceSettingsPanel.vue'

interface Capture {
  constraints: MediaStreamConstraints
  track: { readyState: 'live' | 'ended'; stop: () => void }
  resolve: () => void
}

let captures: Capture[] = []
let wrapper: VueWrapper | null = null

beforeEach(() => {
  captures = []
  const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => new Promise<MediaStream>((resolve) => {
    const track = { readyState: 'live' as 'live' | 'ended', stop() { track.readyState = 'ended' }, kind: 'video' }
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] }
    captures.push({ constraints, track, resolve: () => resolve(stream as unknown as MediaStream) })
  }))
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn(), enumerateDevices: vi.fn(async () => []) },
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const views: Array<[string, Component, Record<string, unknown>]> = [
  ['Settings > Voice & video', VoiceSettingsInline, {}],
  ["the call's settings panel", VoiceSettingsPanel, { isOpen: true }],
]

async function open(view: Component, props: Record<string, unknown>) {
  wrapper = mount(view, {
    props,
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, stubs: { Icon: true, VoiceInputModeSettings: true, DeviceAccessNote: true, teleport: true } },
  })
  await flushPromises()
  return wrapper
}

const videoCaptures = () => captures.filter((c) => c.constraints.video)

describe.each(views)('camera preview of %s', (_name, view, props) => {
  it('stops a capture that resolves after the view closed', async () => {
    const w = await open(view, props)
    expect(videoCaptures()).toHaveLength(1)

    w.unmount()
    wrapper = null
    videoCaptures()[0].resolve()
    await flushPromises()

    expect(videoCaptures()[0].track.readyState).toBe('ended')
  })

  it('keeps only the capture of the last camera chosen', async () => {
    const w = await open(view, props)
    const cameraSelect = w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'cam-2'))!
    await cameraSelect.setValue('cam-2')
    await flushPromises()
    const all = videoCaptures()
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect((all.at(-1)!.constraints.video as MediaTrackConstraints).deviceId).toBe('cam-2')

    // Newest first: the earlier captures resolve late.
    for (const capture of [...all].reverse()) {
      capture.resolve()
      await flushPromises()
    }

    expect(all.map((c) => c.track.readyState)).toEqual([...all.slice(1).map(() => 'ended'), 'live'])
  })
})
