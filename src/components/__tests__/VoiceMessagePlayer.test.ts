import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const level = vi.hoisted(() => ({
  gain: { gain: { value: 1 }, connect: vi.fn() },
  source: { connect: vi.fn() },
  ctx: null as any,
  clip: { peak: -30.5, duration: 9.5 } as { peak: number; duration: number } | null,
}))
vi.mock('@/services/voice/voiceMessageLevel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/voice/voiceMessageLevel')>()
  return {
    ...actual,
    voiceMessageContext: () => level.ctx,
    measureClip: vi.fn(async () => level.clip),
  }
})
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))

import VoiceMessagePlayer from '../VoiceMessagePlayer.vue'

class FakeAudio {
  static last: FakeAudio
  src = ''
  crossOrigin: string | null = null
  preload = ''
  currentTime = 0
  duration = Infinity
  playbackRate = 1
  playResult: Promise<void> = Promise.resolve()
  listeners = new Map<string, Array<() => void>>()
  constructor() { FakeAudio.last = this }
  addEventListener(event: string, cb: () => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]) }
  removeAttribute(name: string) { if (name === 'crossorigin') this.crossOrigin = null }
  emit(event: string) { for (const cb of this.listeners.get(event) ?? []) cb() }
  play() { this.emit('play'); return this.playResult }
  pause() { this.emit('pause') }
  load() {}
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio)
  level.gain = { gain: { value: 1 }, connect: vi.fn() }
  level.clip = { peak: -30.5, duration: 9.5 }
  level.ctx = {
    createMediaElementSource: vi.fn(() => level.source),
    createGain: vi.fn(() => level.gain),
    resume: vi.fn(async () => {}),
    destination: {},
  }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

function mountPlayer(props: Record<string, unknown> = {}) {
  wrapper = mount(VoiceMessagePlayer, { props: { src: 'https://db/clip.webm', duration: 9.5, waveform: [0.2, 0.4], ...props } })
  return wrapper
}

describe('VoiceMessagePlayer', () => {
  it('loads the clip in CORS mode and names its controls', () => {
    const w = mountPlayer()
    expect(FakeAudio.last.crossOrigin).toBe('anonymous')
    expect(w.get('.voice-player').attributes('role')).toBe('group')
    expect(w.get('.play-btn').attributes('aria-label')).toContain('voiceMessage.play')
    const slider = w.get('[role="slider"]')
    expect(slider.attributes('tabindex')).toBe('0')
    expect(slider.attributes('aria-valuemax')).toBe('10')
    expect(slider.attributes('aria-valuetext')).toContain('"total":"0:09"')
    expect(w.get('.speed-btn').attributes('aria-label')).toContain('"speed":1')
  })

  it('plays through a gain node that raises a quiet clip', async () => {
    const w = mountPlayer()
    await w.get('.play-btn').trigger('click')
    await flushPromises()
    expect(level.ctx.createMediaElementSource).toHaveBeenCalledWith(FakeAudio.last)
    expect(level.source.connect).toHaveBeenCalledWith(level.gain)
    expect(20 * Math.log10(level.gain.gain.value)).toBeCloseTo(24)
    expect(w.get('.play-btn').attributes('aria-label')).toBe('voiceMessage.pause')
  })

  it('keeps unit gain when the clip cannot be measured', async () => {
    level.clip = null
    const w = mountPlayer()
    await w.get('.play-btn').trigger('click')
    await flushPromises()
    expect(level.gain.gain.value).toBe(1)
  })

  it('a source without CORS headers reloads without crossOrigin and plays unboosted', async () => {
    const w = mountPlayer()
    FakeAudio.last.emit('error')
    expect(FakeAudio.last.crossOrigin).toBeNull()
    await w.get('.play-btn').trigger('click')
    expect(level.ctx.createMediaElementSource).not.toHaveBeenCalled()
  })

  it('arrow, Home and End keys move the position', async () => {
    const w = mountPlayer()
    const slider = w.get('[role="slider"]')
    await slider.trigger('keydown', { key: 'ArrowRight' })
    expect(FakeAudio.last.currentTime).toBe(5)
    await slider.trigger('keydown', { key: 'ArrowRight' })
    expect(FakeAudio.last.currentTime).toBe(9.5)
    await slider.trigger('keydown', { key: 'Home' })
    expect(FakeAudio.last.currentTime).toBe(0)
    await slider.trigger('keydown', { key: 'End' })
    expect(FakeAudio.last.currentTime).toBe(9.5)
  })

  it('announces a clip that fails to play', async () => {
    const w = mountPlayer()
    FakeAudio.last.playResult = Promise.reject(new DOMException('no', 'NotSupportedError'))
    await w.get('.play-btn').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('voiceMessage.playFailed')
  })
})
