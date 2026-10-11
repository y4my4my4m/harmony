/**
 * AuthComponent.vue for keyboard and screen-reader users: field errors tied to
 * their inputs, a reachable Remember me checkbox, a named password toggle, a
 * busy submit that keeps its name, and the forgot-password and second-factor
 * dialogs taking focus with labelled fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { resetLayersForTests } from '@/utils/a11y/layers'

const { authStore, push, toast, sb } = vi.hoisted(() => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    authStore: {
      _pendingMFAVerification: false,
      session: null as unknown,
      login: vi.fn(),
      register: vi.fn(),
      verify2FA: vi.fn(),
      completeRecoverySignIn: vi.fn(),
      cancelPendingSignIn: vi.fn(),
      resetPassword: vi.fn(),
    },
    push: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    sb: {
      from: vi.fn(() => chain),
      auth: {
        signOut: vi.fn().mockResolvedValue({ error: null }),
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
    },
  }
})

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => ({ query: {} }) }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authStore }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: {} }) }))
vi.mock('@/supabase', () => ({
  supabase: sb,
  signOutAndForget: vi.fn(),
  setRememberMe: vi.fn(),
  getRememberMe: () => true,
}))
vi.mock('@/utils/backgroundUtils', () => ({ getRandomLoginBackground: vi.fn().mockResolvedValue('') }))
vi.mock('@/services/AdminService', () => ({ adminService: { getInstanceConfig: vi.fn().mockResolvedValue(null) } }))
vi.mock('@/services/instanceConfig', () => ({ getStoredInstance: () => null }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false }))

import AuthComponent from '@/components/AuthComponent.vue'

let wrapper: VueWrapper | null = null

async function mountAuth(isLogin = true) {
  wrapper = mount(AuthComponent, {
    props: { isLogin },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, stubs: { 'i18n-t': true } },
  })
  await flushPromises()
  return wrapper
}

const byId = (id: string | undefined) => (id ? document.getElementById(id) : null)

describe('AuthComponent accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLayersForTests()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('submitting empty fields marks them invalid, links the errors and focuses the first', async () => {
    const w = await mountAuth()
    await w.find('[data-testid="auth-form"]').trigger('submit')
    await flushPromises()

    const email = w.find('[data-testid="auth-email"]')
    expect(email.attributes('aria-invalid')).toBe('true')
    const error = byId(email.attributes('aria-describedby'))
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toBe('auth.errors.emailRequired')
    expect(document.activeElement).toBe(email.element)

    const password = w.find('[data-testid="auth-password"]')
    expect(password.attributes('aria-invalid')).toBe('true')
    expect(byId(password.attributes('aria-describedby'))?.textContent).toBe('auth.errors.passwordRequired')
    expect(authStore.login).not.toHaveBeenCalled()
  })

  it('error regions stay mounted while empty, and typing clears the invalid state', async () => {
    const w = await mountAuth()
    expect(w.find('#email-error').attributes('role')).toBe('alert')
    expect(w.find('#email-error').text()).toBe('')
    expect(w.find('[data-testid="auth-email"]').attributes('aria-invalid')).toBeUndefined()

    await w.find('[data-testid="auth-email"]').setValue('not-an-address')
    await w.find('[data-testid="auth-email"]').trigger('blur')
    expect(w.find('#email-error').text()).toBe('auth.errors.invalidEmail')
    await w.find('[data-testid="auth-email"]').setValue('a@b.co')
    expect(w.find('[data-testid="auth-email"]').attributes('aria-invalid')).toBeUndefined()
  })

  it('a rejected sign-in is shown in the form alert, not only a toast', async () => {
    authStore.login.mockRejectedValue(new Error('Invalid login credentials'))
    const w = await mountAuth()
    await w.find('[data-testid="auth-email"]').setValue('user@example.com')
    await w.find('[data-testid="auth-password"]').setValue('wrong-password')
    await w.find('[data-testid="auth-form"]').trigger('submit')
    await flushPromises()
    const alert = w.find('[data-testid="auth-form-error"]')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toBe('Invalid login credentials')
  })

  it('Remember me is a native checkbox named by its label', async () => {
    const w = await mountAuth()
    const box = w.find('[data-testid="auth-remember-me"]')
    expect(box.element.tagName).toBe('INPUT')
    expect(box.attributes('type')).toBe('checkbox')
    expect(box.element.closest('label')?.textContent).toContain('auth.rememberMe')
    expect(box.attributes('tabindex')).toBeUndefined()
    expect((box.element as HTMLInputElement).checked).toBe(true)
  })

  it('the password toggle is a focusable named toggle button', async () => {
    const w = await mountAuth()
    const toggle = w.find('[data-testid="auth-password-toggle"]')
    expect(toggle.attributes('tabindex')).toBeUndefined()
    expect(toggle.attributes('aria-label')).toBe('auth.showPassword')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    expect(toggle.attributes('aria-controls')).toBe('password')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="auth-password"]').attributes('type')).toBe('text')
  })

  it('the busy submit keeps focus, a name and aria-busy', async () => {
    let resolve: (v: unknown) => void = () => {}
    authStore.login.mockReturnValue(new Promise((r) => { resolve = r }))
    const w = await mountAuth()
    await w.find('[data-testid="auth-email"]').setValue('user@example.com')
    await w.find('[data-testid="auth-password"]').setValue('secret-password')
    const submit = w.find('[data-testid="auth-submit"]')
    ;(submit.element as HTMLButtonElement).focus()
    await w.find('[data-testid="auth-form"]').trigger('submit')

    expect(submit.attributes('aria-busy')).toBe('true')
    expect(submit.attributes('disabled')).toBeUndefined()
    expect(submit.attributes('aria-disabled')).toBe('true')
    expect(submit.find('.sr-only').text()).toBe('auth.signingIn')
    expect(document.activeElement).toBe(submit.element)

    await w.find('[data-testid="auth-form"]').trigger('submit')
    expect(authStore.login).toHaveBeenCalledTimes(1)
    resolve({ requires2FA: false })
    await flushPromises()
  })

  it('forgot password opens a labelled dialog with focus on the email field; Escape closes it', async () => {
    const w = await mountAuth()
    const opener = w.find('.forgot-link')
    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()

    const dialog = document.querySelector('[data-testid="forgot-password-dialog"]') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(byId(dialog.getAttribute('aria-labelledby') ?? undefined)?.textContent).toBe('auth.resetYourPassword')
    expect(document.activeElement?.id).toBe('forgot-email')

    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-testid="forgot-password-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener.element)
  })

  it('a sent reset link moves focus to "Got it" inside the dialog', async () => {
    authStore.resetPassword.mockResolvedValue({ error: null })
    const w = await mountAuth()
    await w.find('.forgot-link').trigger('click')
    await flushPromises()
    const field = document.getElementById('forgot-email') as HTMLInputElement
    field.value = 'user@example.com'
    field.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="forgot-submit"]') as HTMLElement).click()
    await flushPromises()
    const dialog = document.querySelector('[data-testid="forgot-password-dialog"]') as HTMLElement
    expect(byId(dialog.getAttribute('aria-labelledby') ?? undefined)?.textContent).toBe('auth.checkEmail')
    expect(document.activeElement?.textContent?.trim()).toBe('auth.gotIt')
  })

  it('the second-factor dialog is labelled and focuses a labelled one-time-code field', async () => {
    authStore.login.mockResolvedValue({ requires2FA: true, factorId: 'f', challengeId: 'c', session: null })
    const w = await mountAuth()
    await w.find('[data-testid="auth-email"]').setValue('mfa@example.com')
    await w.find('[data-testid="auth-password"]').setValue('correct horse')
    await w.find('[data-testid="auth-form"]').trigger('submit')
    await flushPromises()

    const dialog = document.querySelector('[data-testid="twofa-dialog"]') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(byId(dialog.getAttribute('aria-labelledby') ?? undefined)?.textContent).toBe('auth.twoFactorAuth')
    expect(byId(dialog.getAttribute('aria-describedby') ?? undefined)?.textContent).toBe('auth.enter6DigitCode')

    const code = document.querySelector('[data-testid="twofa-code"]') as HTMLInputElement
    expect(document.activeElement).toBe(code)
    expect(code.getAttribute('inputmode')).toBe('numeric')
    expect(code.getAttribute('autocomplete')).toBe('one-time-code')
    expect(document.querySelector(`label[for="${code.id}"]`)?.textContent).toBe('auth.verificationCode')
    expect(document.querySelector('[data-testid="twofa-close"]')?.getAttribute('aria-label')).toBe('auth.cancelSignIn')
  })

  it('a rejected code is announced, tied to the field and keeps focus there', async () => {
    authStore.login.mockResolvedValue({ requires2FA: true, factorId: 'f', challengeId: 'c', session: null })
    authStore.verify2FA.mockRejectedValue(new Error('Invalid TOTP code entered'))
    const w = await mountAuth()
    await w.find('[data-testid="auth-email"]').setValue('mfa@example.com')
    await w.find('[data-testid="auth-password"]').setValue('correct horse')
    await w.find('[data-testid="auth-form"]').trigger('submit')
    await flushPromises()

    const code = document.querySelector('[data-testid="twofa-code"]') as HTMLInputElement
    code.value = '123456'
    code.dispatchEvent(new Event('input'))
    await flushPromises()

    const error = document.querySelector('[data-testid="twofa-error"]') as HTMLElement
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).not.toBe('')
    expect(code.getAttribute('aria-invalid')).toBe('true')
    expect(code.getAttribute('aria-describedby')).toBe(error.id)
    expect(document.activeElement).toBe(code)
  })
})
