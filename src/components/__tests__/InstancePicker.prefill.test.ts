/**
 * InstancePicker.vue prefill: VITE_DEFAULT_INSTANCE_URL fills the field and
 * focuses Connect; a stored instance wins; unset leaves the field empty and
 * focused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

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
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return mount(InstancePicker, { attachTo: document.body, global: { plugins: [i18n] } })
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
    expect(document.activeElement).toBe(input)
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

describe('InstancePicker dialog', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.stored = null
    mocks.fetchInstanceInfo.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    document.body.innerHTML = ''
  })

  it('is a labelled modal dialog with a labelled field tied to the hint', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', '')
    const wrapper = await mountPicker()
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    const title = document.getElementById(dialog.attributes('aria-labelledby')!)
    expect(title?.textContent).toBe('Welcome to Harmony')
    const input = wrapper.find('input')
    const label = wrapper.find(`label[for="${input.attributes('id')}"]`)
    expect(label.text()).toBe('Instance domain')
    expect(document.getElementById(input.attributes('aria-describedby')!)?.textContent).toContain('federated')
    wrapper.unmount()
  })

  it('keeps focus on the field while connecting and ties the error to it', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', '')
    let reject: (e: Error) => void = () => {}
    mocks.fetchInstanceInfo.mockReturnValue(new Promise((_, r) => { reject = r }))
    const wrapper = await mountPicker()
    const input = wrapper.find('input')
    await input.setValue('nowhere.example')
    ;(input.element as HTMLInputElement).focus()
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('form').attributes('aria-busy')).toBe('true')
    expect(input.attributes('disabled')).toBeUndefined()
    expect(input.attributes('readonly')).toBeDefined()
    expect(wrapper.find('button[type="submit"]').attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(input.element)

    reject(new Error('Not a Harmony instance'))
    await new Promise((r) => setTimeout(r, 0))
    const alert = wrapper.find('[role="alert"]')
    expect(alert.text()).toBe('Not a Harmony instance')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toContain(alert.attributes('id'))
    wrapper.unmount()
  })

  it('Escape closes only when an instance is already stored', async () => {
    vi.stubEnv('VITE_DEFAULT_INSTANCE_URL', '')
    const first = await mountPicker()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(first.emitted('close')).toBeUndefined()
    first.unmount()

    vi.resetModules()
    mocks.stored = { origin: 'https://mine.example', name: 'Mine' }
    const second = await mountPicker()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(second.emitted('close')).toHaveLength(1)
    second.unmount()
  })
})
