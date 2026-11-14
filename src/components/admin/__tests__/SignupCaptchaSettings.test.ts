/**
 * SignupCaptchaSettings.vue: turning a provider on or saving new keys needs a passing test through
 * admin_test_signup_captcha; a failed one names its fix. A mode change alone saves untested.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { load, save, test, counts } = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  test: vi.fn(),
  counts: vi.fn().mockResolvedValue({ asked: 0, passed: 0, failed: 0, unverified: 0 }),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params?.host ? `${key}:${params.host}` : key),
    locale: { value: 'en' },
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-1' } } }) }))
vi.mock('@/services/instanceConfig', () => ({ getStoredInstance: () => null }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/SignupCaptchaService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/SignupCaptchaService')>()),
  loadSignupCaptchaSettings: load,
  saveSignupCaptchaSettings: save,
  testSignupCaptcha: test,
  loadSignupCaptchaCounts: counts,
}))

import SignupCaptchaSettings from '@/components/admin/SignupCaptchaSettings.vue'
import SignupCaptcha from '@/components/auth/SignupCaptcha.vue'

let wrapper: VueWrapper | null = null

async function mountCard(saved = { provider: 'off', siteKey: '', mode: 'suspect', secretSet: false }) {
  load.mockResolvedValueOnce(saved)
  wrapper = mount(SignupCaptchaSettings, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const q = (id: string) => wrapper!.get(`[data-testid="${id}"]`)

async function fillTurnstile() {
  await q('signup-captcha-provider').setValue('turnstile')
  await q('signup-captcha-site-key').setValue('0x4AAAAAAA')
  await q('signup-captcha-secret').setValue('0x4AAAAAAA-secret')
}

async function solve(token = 'tok') {
  await q('signup-captcha-test').trigger('click')
  wrapper!.findComponent(SignupCaptcha).vm.$emit('token', token)
  await flushPromises()
}

describe('SignupCaptchaSettings', () => {
  beforeAll(() => {
    const settings = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM?.settings
    if (settings) settings.disableIframePageLoading = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    load.mockReset()
    test.mockReset()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('refuses to turn a provider on before a passing test', async () => {
    await mountCard()
    await fillTurnstile()
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(q('signup-captcha-error').text()).toBe('adminSignupCaptcha.needsTest')
  })

  it('verifies the token with the entered secret, then saves', async () => {
    test.mockResolvedValueOnce({ verdict: 'pass', codes: [], detail: 'answer', http_status: 200 })
    await mountCard()
    await fillTurnstile()
    await solve('tok-1')
    expect(test).toHaveBeenCalledWith('turnstile', 'tok-1', '0x4AAAAAAA-secret')
    expect(q('signup-captcha-test-result').text()).toBe('adminSignupCaptcha.testPassed')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[2]).toBe('0x4AAAAAAA-secret')
  })

  it('forgets a pass once the keys change', async () => {
    test.mockResolvedValueOnce({ verdict: 'pass', codes: [], detail: 'answer', http_status: 200 })
    await mountCard()
    await fillTurnstile()
    await solve()
    await q('signup-captcha-site-key').setValue('0x4BBBBBBB')
    expect(wrapper!.find('[data-testid="signup-captcha-test-result"]').exists()).toBe(false)
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
  })

  it('names the fix for a refused secret and for a hostname the widget lacks', async () => {
    test.mockResolvedValueOnce({ verdict: 'error', codes: ['invalid-input-secret'], detail: 'answer', http_status: 200 })
    await mountCard()
    await fillTurnstile()
    await solve()
    expect(q('signup-captcha-test-result').text()).toBe(
      `adminSignupCaptcha.problem.secret:${window.location.hostname} (invalid-input-secret)`)

    await q('signup-captcha-test').trigger('click')
    wrapper!.findComponent(SignupCaptcha).vm.$emit('error', '110200')
    await flushPromises()
    expect(q('signup-captcha-test-result').text()).toBe(`adminSignupCaptcha.problem.hostname:${window.location.hostname} (110200)`)
    expect(save).not.toHaveBeenCalled()
  })

  it('saves a mode change on a working provider without a test', async () => {
    await mountCard({ provider: 'turnstile', siteKey: '0x4AAAAAAA', mode: 'suspect', secretSet: true })
    await q('signup-captcha-mode-always').setValue(true)
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(test).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[0]).toMatchObject({ provider: 'turnstile', mode: 'always' })
  })

  it('tests a stored secret when none is entered', async () => {
    test.mockResolvedValueOnce({ verdict: 'pass', codes: [], detail: 'answer', http_status: 200 })
    await mountCard({ provider: 'turnstile', siteKey: '0x4AAAAAAA', mode: 'suspect', secretSet: true })
    await q('signup-captcha-site-key').setValue('0x4CCCCCCC')
    await solve()
    expect(test).toHaveBeenCalledWith('turnstile', 'tok', '')
    await wrapper!.get('form').trigger('submit')
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
  })
})
