/**
 * src/services/SignupCaptchaService.ts: the admin settings of the sign-up check. The secret key is
 * written when entered and never read into the form.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { rows, setInstanceConfigs, rpc } = vi.hoisted(() => ({
  rows: { value: [] as Array<Record<string, unknown>> },
  setInstanceConfigs: vi.fn().mockResolvedValue(undefined),
  rpc: vi.fn(),
}))

vi.mock('@/supabase', () => {
  const chain: any = {
    select: () => chain,
    in: () => Promise.resolve({ data: rows.value, error: null }),
    gte: () => Promise.resolve({ data: rows.value, error: null }),
  }
  return { supabase: { from: () => chain, rpc } }
})
vi.mock('@/services/AdminService', () => ({ adminService: { setInstanceConfigs } }))

import {
  checkProblem,
  isValidSecret,
  isValidSiteKey,
  loadSignupCaptchaCounts,
  loadSignupCaptchaSettings,
  saveSignupCaptchaSettings,
  SIGNUP_CAPTCHA_DEFAULTS,
  testSignupCaptcha,
  widgetProblem,
  type SignupCaptchaCheck,
} from '@/services/SignupCaptchaService'

const answer = (over: Partial<SignupCaptchaCheck>): SignupCaptchaCheck => ({ verdict: 'error', codes: [], detail: 'answer', ...over })

describe('SignupCaptchaService', () => {
  beforeEach(() => {
    rows.value = []
    setInstanceConfigs.mockClear()
  })

  it('loads the settings and only whether a secret is stored', async () => {
    rows.value = [
      { config_key: 'signup_captcha_provider', config_value: 'turnstile' },
      { config_key: 'signup_captcha_site_key', config_value: '0x4AAAAAAA' },
      { config_key: 'signup_captcha_secret', config_value: '0x4AAAAAAA-secret' },
      { config_key: 'signup_captcha_mode', config_value: 'always' },
    ]
    const settings = await loadSignupCaptchaSettings()
    expect(settings).toEqual({ provider: 'turnstile', siteKey: '0x4AAAAAAA', mode: 'always', secretSet: true })
    expect(JSON.stringify(settings)).not.toContain('secret"')
    expect(JSON.stringify(settings)).not.toContain('0x4AAAAAAA-secret')
  })

  it('falls back to off and suspect on unknown or missing values', async () => {
    rows.value = [
      { config_key: 'signup_captcha_provider', config_value: 'recaptcha' },
      { config_key: 'signup_captcha_mode', config_value: 'sometimes' },
    ]
    expect(await loadSignupCaptchaSettings()).toEqual(SIGNUP_CAPTCHA_DEFAULTS)
  })

  it('writes what changed, and the secret only when one was entered', async () => {
    const saved = { provider: 'off', siteKey: '', mode: 'suspect', secretSet: false } as const
    await saveSignupCaptchaSettings({ ...saved, provider: 'hcaptcha', siteKey: ' key-1 ' }, saved, ' sec-1 ', 'admin')
    expect(setInstanceConfigs).toHaveBeenLastCalledWith(
      { signup_captcha_provider: 'hcaptcha', signup_captcha_site_key: 'key-1', signup_captcha_secret: 'sec-1' },
      'admin',
    )
    const next = { provider: 'hcaptcha', siteKey: 'key-1', mode: 'suspect', secretSet: true } as const
    await saveSignupCaptchaSettings({ ...next, mode: 'always' }, next, '', 'admin')
    expect(setInstanceConfigs).toHaveBeenLastCalledWith({ signup_captcha_mode: 'always' }, 'admin')
  })

  it('validates keys as both providers issue them', () => {
    expect(isValidSiteKey('0x4AAAAAAABkMYinukE8nzY')).toBe(true)
    expect(isValidSiteKey('10000000-ffff-ffff-ffff-000000000001')).toBe(true)
    expect(isValidSiteKey('has space')).toBe(false)
    expect(isValidSiteKey('')).toBe(false)
    expect(isValidSecret('0x4AAAAAAABkMYinukE8nzY_secret')).toBe(true)
    expect(isValidSecret('ES_abc123')).toBe(true)
    expect(isValidSecret('two words')).toBe(false)
  })

  it('tests a token with the entered secret, or the stored one when none is entered', async () => {
    rpc.mockResolvedValueOnce({ data: { verdict: 'pass', codes: [], detail: 'answer', http_status: 200 }, error: null })
    expect(await testSignupCaptcha('turnstile', 'tok', ' sec ')).toEqual({
      verdict: 'pass', codes: [], detail: 'answer', http_status: 200, message: undefined,
    })
    expect(rpc).toHaveBeenLastCalledWith('admin_test_signup_captcha', { p_provider: 'turnstile', p_token: 'tok', p_secret: 'sec' })
    rpc.mockResolvedValueOnce({ data: { verdict: 'odd', codes: 'x' }, error: null })
    expect(await testSignupCaptcha('hcaptcha', 'tok', '')).toMatchObject({ verdict: 'error', codes: [] })
    expect(rpc).toHaveBeenLastCalledWith('admin_test_signup_captcha', { p_provider: 'hcaptcha', p_token: 'tok', p_secret: null })
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Unauthorized: Admin role required', code: '42501' } })
    await expect(testSignupCaptcha('turnstile', 'tok', '')).rejects.toMatchObject({ code: '42501' })
  })

  it('names the fix for each siteverify answer', () => {
    expect(checkProblem(answer({ verdict: 'pass' }))).toBeNull()
    expect(checkProblem(answer({ detail: 'no_secret' }))).toBe('noSecret')
    expect(checkProblem(answer({ detail: 'no_http' }))).toBe('noHttp')
    expect(checkProblem(answer({ detail: 'network', message: 'Could not resolve host' }))).toBe('network')
    expect(checkProblem(answer({ codes: ['invalid-input-secret'] }))).toBe('secret')
    expect(checkProblem(answer({ codes: ['missing-input-secret'] }))).toBe('secret')
    expect(checkProblem(answer({ codes: ['sitekey-secret-mismatch'] }))).toBe('mismatch')
    expect(checkProblem(answer({ http_status: 503 }))).toBe('status')
    expect(checkProblem(answer({ verdict: 'fail', codes: ['invalid-input-response'], http_status: 200 }))).toBe('token')
    expect(checkProblem(answer({ codes: ['internal-error'], http_status: 200 }))).toBe('unknown')
  })

  it('names the fix for the widget errors', () => {
    expect(widgetProblem('110200')).toBe('hostname')
    expect(widgetProblem('110100')).toBe('siteKey')
    expect(widgetProblem('110110')).toBe('siteKey')
    expect(widgetProblem('200500')).toBe('widgetNetwork')
    expect(widgetProblem('network-error')).toBe('widgetNetwork')
    expect(widgetProblem('600010')).toBe('widget')
  })

  it('sums the counts of the window', async () => {
    rows.value = [
      { asked: 3, passed: 2, failed: 1, unverified: 0 },
      { asked: 1, passed: 1, failed: 0, unverified: 4 },
    ]
    expect(await loadSignupCaptchaCounts()).toEqual({ asked: 4, passed: 3, failed: 1, unverified: 4 })
  })
})
