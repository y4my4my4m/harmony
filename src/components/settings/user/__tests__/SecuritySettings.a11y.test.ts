/**
 * Settings > Security password form: a field error sets aria-invalid, is
 * linked through aria-describedby to a role="alert" message, and takes focus.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const { verifyPassword } = vi.hoisted(() => ({ verifyPassword: vi.fn() }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/services/AccountSecurityService', () => ({
  accountSecurityService: { verifyPassword },
  securityErrorMessage: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('../TwoFactorSettings.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'TwoFactorStub', render: () => h('div') }) }
})
vi.mock('../SessionsPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'SessionsStub', setup: (_p, { expose }) => { expose({ load: vi.fn() }) }, render: () => h('div') }) }
})

import SecuritySettings from '../SecuritySettings.vue'

let wrapper: VueWrapper

beforeEach(() => {
  setActivePinia(createPinia())
  verifyPassword.mockReset()
  wrapper = mount(SecuritySettings, {
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
})

afterEach(() => wrapper.unmount())

function expectLinkedError(inputId: string, message: string) {
  const input = document.getElementById(inputId)!
  expect(input.getAttribute('aria-invalid')).toBe('true')
  const error = document.getElementById(input.getAttribute('aria-describedby')!)!
  expect(error.getAttribute('role')).toBe('alert')
  expect(error.textContent).toBe(message)
  expect(document.activeElement).toBe(input)
}

describe('SecuritySettings password errors', () => {
  it('describes the new password by its hint until an error replaces it', async () => {
    const input = wrapper.get('#new-password')
    expect(input.attributes('aria-invalid')).toBeUndefined()
    expect(document.getElementById(input.attributes('aria-describedby')!)?.textContent)
      .toBe('security.password.hint')
  })

  it('links a too-short new password', async () => {
    await wrapper.get('#current-password').setValue('old-password')
    await wrapper.get('#new-password').setValue('short')
    await wrapper.get('#confirm-password').setValue('short')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expectLinkedError('new-password', 'security.password.errors.tooShort')
  })

  it('links a mismatched confirmation', async () => {
    await wrapper.get('#current-password').setValue('old-password')
    await wrapper.get('#new-password').setValue('long enough one')
    await wrapper.get('#confirm-password').setValue('long enough two')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expectLinkedError('confirm-password', 'security.password.errors.mismatch')
  })

  it('links a wrong current password and clears the state on input', async () => {
    verifyPassword.mockResolvedValue(false)
    await wrapper.get('#current-password').setValue('wrong-password')
    await wrapper.get('#new-password').setValue('long enough one')
    await wrapper.get('#confirm-password').setValue('long enough one')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expectLinkedError('current-password', 'security.password.errors.wrongCurrent')

    await wrapper.get('#current-password').setValue('again')
    expect(wrapper.get('#current-password').attributes('aria-invalid')).toBeUndefined()
    expect(wrapper.find('#current-password-error').exists()).toBe(false)
  })
})
