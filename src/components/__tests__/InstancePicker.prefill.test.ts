/**
 * InstancePicker.vue prefill: VITE_DEFAULT_INSTANCE_URL fills the field and
 * focuses Connect; a stored instance wins; unset leaves the field empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  stored: null as null | { origin: string; name: string },
  fetchInstanceInfo: vi.fn(),
}))

vi.mock('@/services/instanceConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/instanceConfig')>()),
  getStoredInstance: () => mocks.stored,
  setStoredInstance: vi.fn(),
  fetchInstanceInfo: mocks.fetchInstanceInfo,
}))

async function mountPicker() {
  const { default: InstancePicker } = await import('../InstancePicker.vue')
  return mount(InstancePicker, { attachTo: document.body })
}

describe('InstancePicker prefill', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.stored = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    document.body.innerHTML = ''
  })

  it('prefills the default instance and focuses Connect', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', 'https://har.mony.lol')
    const wrapper = await mountPicker()
    const input = wrapper.find('input').element as HTMLInputElement
    const button = wrapper.find('button[type="submit"]').element as HTMLButtonElement
    expect(input.value).toBe('har.mony.lol')
    expect(button.disabled).toBe(false)
    expect(document.activeElement).toBe(button)
    expect(input.hasAttribute('autofocus')).toBe(false)
    wrapper.unmount()
  })

  it('keeps the prefill editable', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', 'https://har.mony.lol')
    const wrapper = await mountPicker()
    await wrapper.find('input').setValue('other.example')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('other.example')
    wrapper.unmount()
  })

  it('leaves the field empty when unset', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', '')
    const wrapper = await mountPicker()
    const input = wrapper.find('input').element as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.hasAttribute('autofocus')).toBe(true)
    expect((wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled).toBe(true)
    wrapper.unmount()
  })

  it('prefers the stored instance over the default', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', 'https://har.mony.lol')
    mocks.stored = { origin: 'https://mine.example', name: 'Mine' }
    const wrapper = await mountPicker()
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('mine.example')
    expect(document.activeElement).not.toBe(wrapper.find('button[type="submit"]').element)
    wrapper.unmount()
  })
})
