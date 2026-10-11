/**
 * Settings > Security > Two-factor: code inputs carry a label, numeric input
 * mode and one-time-code autocomplete; errors are linked alerts; the setup key
 * is a labelled group with a named copy button; the confirmation modal is a
 * labelled dialog that takes focus.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { supabase } from '@/supabase'
import { resetLayersForTests } from '@/utils/a11y/layers'

const { security, polite } = vi.hoisted(() => ({
  security: {
    getRecoveryStatus: vi.fn(async () => ({ remaining: 8, total: 10 })),
    stepUpWithTotp: vi.fn(),
    generateRecoveryCodes: vi.fn(async () => ['AAAA-BBBB']),
  },
  polite: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,') } }))
vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }),
}))
vi.mock('@/services/AccountSecurityService', () => ({
  accountSecurityService: security,
  recoveryCodesText: () => '',
  saveBlob: vi.fn(),
  securityErrorMessage: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', render: () => h('span') }) }
})

import TwoFactorSettings from '../TwoFactorSettings.vue'

const mfa = {
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(async () => ({ error: null })),
  challengeAndVerify: vi.fn(),
}

let wrapper: VueWrapper

async function mountWith(verified: boolean) {
  mfa.listFactors.mockResolvedValue({
    data: verified
      ? { totp: [{ id: 'f1', status: 'verified' }], all: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }
      : { totp: [], all: [] },
    error: null,
  })
  wrapper = mount(TwoFactorSettings, {
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetLayersForTests()
  ;(supabase.auth as unknown as { mfa: typeof mfa }).mfa = mfa
  mfa.enroll.mockResolvedValue({ data: { id: 'f2', totp: { secret: 'ABCDEFGHIJKLMNOP', uri: 'otpauth://x' } }, error: null })
  security.stepUpWithTotp.mockReset()
  polite.mockClear()
})

afterEach(() => wrapper.unmount())

describe('TwoFactorSettings enrolment', () => {
  it('labels the setup key as a group and names its copy button', async () => {
    await mountWith(false)
    await wrapper.get('[data-testid="twofa-setup"]').trigger('click')
    await flushPromises()

    const secret = wrapper.get('[data-testid="twofa-secret"]')
    expect(secret.attributes('aria-label')).toBeUndefined()
    const group = secret.element.closest('[role="group"]')!
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('security.twoFactor.setupKey')
    const copy = group.querySelector('button')!
    expect(copy.getAttribute('aria-label')).toBe('security.twoFactor.copySetupKey')
    // Focus moves from the unmounted Set up button to the step's lead text.
    expect(document.activeElement?.textContent).toBe('security.twoFactor.scanQr')
  })

  it('gives the enrolment code input a label, numeric mode and one-time-code autocomplete', async () => {
    await mountWith(false)
    await wrapper.get('[data-testid="twofa-setup"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('.sec-btn-primary').at(-1)!.trigger('click')
    await flushPromises()

    const input = wrapper.get('[data-testid="twofa-enroll-code"]')
    expect(document.querySelector(`label[for="${input.attributes('id')}"]`)?.textContent).toBe('security.twoFactor.enterEnrollCode')
    expect(input.attributes('inputmode')).toBe('numeric')
    expect(input.attributes('autocomplete')).toBe('one-time-code')
    expect(document.activeElement).toBe(input.element)

    mfa.challengeAndVerify.mockResolvedValue({ error: new Error('bad') })
    await input.setValue('123456')
    await flushPromises()
    expect(input.attributes('aria-invalid')).toBe('true')
    const error = document.getElementById(input.attributes('aria-describedby')!)!
    expect(error.getAttribute('role')).toBe('alert')
  })
})

describe('TwoFactorSettings confirmation modal', () => {
  it('is a labelled dialog whose code input is labelled and focused', async () => {
    await mountWith(true)
    await wrapper.get('[data-testid="twofa-disable"]').trigger('click')
    await flushPromises()
    await nextTick()

    const dialog = document.querySelector<HTMLElement>('[data-testid="twofa-code-modal"]')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent?.trim())
      .toBe('security.twoFactor.disableModal.title')

    const input = dialog.querySelector<HTMLInputElement>('[data-testid="twofa-modal-code"]')!
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBe('auth.verificationCode')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(document.activeElement).toBe(input)
  })

  it('links a rejected code as an alert and keeps focus on the input', async () => {
    await mountWith(true)
    await wrapper.get('[data-testid="twofa-disable"]').trigger('click')
    await flushPromises()
    security.stepUpWithTotp.mockRejectedValue(new Error('invalid'))

    const input = document.querySelector<HTMLInputElement>('[data-testid="twofa-modal-code"]')!
    input.value = '123456'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    document.querySelector<HTMLFormElement>('[data-testid="twofa-code-modal"]')!
      .dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()

    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(error.getAttribute('role')).toBe('alert')
    expect(document.activeElement).toBe(input)
  })

  it('closes on Escape and returns focus to the button that opened it', async () => {
    await mountWith(true)
    const opener = wrapper.get('[data-testid="twofa-disable"]')
    ;(opener.element as HTMLElement).focus()
    await opener.trigger('click')
    await flushPromises()

    // happy-dom: HTMLFormElement.contains() is false for its own fields, so the
    // layer check runs against the dialog element itself.
    const dialog = document.querySelector<HTMLElement>('[data-testid="twofa-code-modal"]')!
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.querySelector('[data-testid="twofa-code-modal"]')).toBeNull()
    expect(document.activeElement).toBe(opener.element)
  })
})
