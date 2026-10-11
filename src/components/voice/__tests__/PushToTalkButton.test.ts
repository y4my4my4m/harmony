import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'

// On-screen push to talk: a hold transmits while held; a tap, or a click with
// no pointer behind it (screen-reader double tap), latches until the next one;
// Space or Enter held on the focused button is a hold.

const h = vi.hoisted(() => ({ active: null as any, press: vi.fn(), release: vi.fn() }))
vi.mock('@/composables/useKeybinds', () => ({
  useKeybinds: () => ({
    isPTTActive: h.active,
    pressHold: (...a: unknown[]) => { h.active.value = true; h.press(...a) },
    releaseHold: (...a: unknown[]) => { h.active.value = false; h.release(...a) },
  }),
}))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))

import PushToTalkButton from '../PushToTalkButton.vue'

let wrapper: VueWrapper | null = null

function mountButton(disabled = false) {
  h.active = ref(false)
  h.press.mockClear()
  h.release.mockClear()
  wrapper = mount(PushToTalkButton, { props: { disabled }, attachTo: document.body })
  return wrapper.find('button')
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('PushToTalkButton', () => {
  it('latches on a click without a pointer and unlatches on the next', async () => {
    const button = mountButton()
    await button.trigger('click')
    expect(h.press).toHaveBeenCalledWith('push-to-talk')
    expect(button.attributes('aria-pressed')).toBe('true')
    await button.trigger('click')
    expect(h.release).toHaveBeenCalledWith('push-to-talk')
    expect(button.attributes('aria-pressed')).toBe('false')
  })

  it('holds while a long press lasts and ignores the trailing click', async () => {
    vi.useFakeTimers()
    const button = mountButton()
    await button.trigger('pointerdown', { pointerId: 1 })
    expect(h.press).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    await button.trigger('pointerup', { pointerId: 1 })
    await button.trigger('click')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(button.attributes('aria-pressed')).toBe('false')
  })

  it('latches on a short tap and releases on the next tap', async () => {
    vi.useFakeTimers()
    const button = mountButton()
    await button.trigger('pointerdown', { pointerId: 1 })
    vi.advanceTimersByTime(100)
    await button.trigger('pointerup', { pointerId: 1 })
    await button.trigger('click')
    expect(h.release).not.toHaveBeenCalled()
    expect(button.attributes('aria-pressed')).toBe('true')

    await button.trigger('pointerdown', { pointerId: 1 })
    await button.trigger('pointerup', { pointerId: 1 })
    await button.trigger('click')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(button.attributes('aria-pressed')).toBe('false')
  })

  it('holds for as long as Space or Enter is held', async () => {
    const button = mountButton()
    await button.trigger('keydown', { key: ' ' })
    await button.trigger('keydown', { key: ' ', repeat: true })
    expect(h.press).toHaveBeenCalledTimes(1)
    await button.trigger('keyup', { key: ' ' })
    expect(h.release).toHaveBeenCalledTimes(1)
    await button.trigger('keydown', { key: 'Enter' })
    await button.trigger('keyup', { key: 'Enter' })
    expect(h.press).toHaveBeenCalledTimes(2)
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it('stays focusable when muted, announces it and does nothing', async () => {
    const button = mountButton(true)
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-disabled')).toBe('true')
    await button.trigger('click')
    await button.trigger('keydown', { key: ' ' })
    expect(h.press).not.toHaveBeenCalled()
  })

  it('has a description of how to operate it', () => {
    const button = mountButton()
    const hint = document.getElementById(button.attributes('aria-describedby')!)
    expect(hint?.textContent).toBe('voice.pttButtonHint')
  })
})
