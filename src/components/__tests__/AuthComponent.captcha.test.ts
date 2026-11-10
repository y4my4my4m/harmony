/**
 * AuthComponent.vue and the sign-up check (20261111100001): a 428 from the sign-up hook shows the
 * widget, its token resubmits the form as user_metadata.captcha_token, and a refused token resets
 * the widget. With no usable widget settings the server's text is shown.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const ASKED = 'Complete the check to finish signing up. If no check appears, update the app or sign up on this instance\'s website.'

const { rows, sb, register } = vi.hoisted(() => {
  const rows: { value: Array<{ config_key: string; config_value: unknown }> } = { value: [] }
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: vi.fn(() => Promise.resolve({ data: rows.value, error: null })),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    rows,
    register: vi.fn(),
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
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: {} }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ _pendingMFAVerification: false, session: { user: { id: 'u' } }, register }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: {} }) }))
vi.mock('@/supabase', () => ({
  supabase: sb,
  signOutAndForget: vi.fn(),
  setRememberMe: vi.fn(),
  getRememberMe: () => true,
}))
vi.mock('@/utils/backgroundUtils', () => ({ loginBackground: vi.fn().mockReturnValue('') }))
vi.mock('@/services/AdminService', () => ({ adminService: { getInstanceConfig: vi.fn().mockResolvedValue(null) } }))
vi.mock('@/services/instanceConfig', () => ({ getStoredInstance: () => null }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false }))

import AuthComponent from '@/components/AuthComponent.vue'
import SignupCaptcha from '@/components/auth/SignupCaptcha.vue'

let wrapper: VueWrapper | null = null

function ask(message = ASKED) {
  return Object.assign(new Error(message), { status: 428 })
}

async function mountRegister() {
  wrapper = mount(AuthComponent, {
    props: { isLogin: false },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key }, stubs: { 'i18n-t': true } },
  })
  await flushPromises()
  await wrapper.get('[data-testid="auth-email"]').setValue('new@example.org')
  await wrapper.get('[data-testid="auth-password"]').setValue('long-enough-1')
  return wrapper
}

async function submit() {
  await wrapper!.get('[data-testid="auth-form"]').trigger('submit')
  await flushPromises()
}

describe('AuthComponent sign-up check', () => {
  beforeAll(() => {
    // happy-dom fetches an iframe's src; the widget page is not served here.
    const settings = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM?.settings
    if (settings) settings.disableIframePageLoading = true
  })
  beforeEach(() => {
    vi.clearAllMocks()
    register.mockReset()
    rows.value = [
      { config_key: 'signup_captcha_provider', config_value: 'turnstile' },
      { config_key: 'signup_captcha_site_key', config_value: '0x4AAAAAAA' },
    ]
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('shows no widget until the hook asks', async () => {
    register.mockResolvedValueOnce(undefined)
    await mountRegister()
    expect(wrapper!.findComponent(SignupCaptcha).exists()).toBe(false)
    await submit()
    expect(register).toHaveBeenCalledWith('new@example.org', 'long-enough-1', undefined)
    expect(wrapper!.findComponent(SignupCaptcha).exists()).toBe(false)
  })

  it('shows the widget on a 428 and resubmits with its token', async () => {
    register.mockRejectedValueOnce(ask()).mockResolvedValueOnce(undefined)
    await mountRegister()
    await submit()
    const widget = wrapper!.findComponent(SignupCaptcha)
    expect(widget.exists()).toBe(true)
    expect(widget.props('config')).toEqual({ provider: 'turnstile', siteKey: '0x4AAAAAAA' })
    expect(widget.find('iframe').attributes('src')).toContain('/embed-player.html?captcha=turnstile&sitekey=0x4AAAAAAA')
    expect(wrapper!.get('[data-testid="auth-form-error"]').text()).toBe('')

    widget.vm.$emit('token', 'tok-1')
    await flushPromises()
    expect(register).toHaveBeenLastCalledWith('new@example.org', 'long-enough-1', 'tok-1')
  })

  it('resets the widget when the token is refused, and sends a token once', async () => {
    register
      .mockRejectedValueOnce(ask())
      .mockRejectedValueOnce(ask('The check did not pass. Try it again.'))
      .mockResolvedValueOnce(undefined)
    await mountRegister()
    await submit()
    const widget = wrapper!.findComponent(SignupCaptcha)
    const frame = widget.find('iframe').element as HTMLIFrameElement
    const posted = vi.fn()
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: posted }, configurable: true })
    widget.vm.$emit('token', 'tok-1')
    await flushPromises()
    expect(posted).toHaveBeenCalledWith({ harmonyPlayer: 1, cmd: 'captcha-reset' }, window.location.origin)
    expect(widget.props('refused')).toBe(true)
    expect(widget.text()).toContain('auth.captcha.refused')
    await submit()
    expect(register).toHaveBeenLastCalledWith('new@example.org', 'long-enough-1', undefined)
  })

  it('asks again, not refused, when the form is sent before the widget answered', async () => {
    register.mockRejectedValueOnce(ask()).mockRejectedValueOnce(ask())
    await mountRegister()
    await submit()
    await submit()
    expect(register).toHaveBeenLastCalledWith('new@example.org', 'long-enough-1', undefined)
    const widget = wrapper!.findComponent(SignupCaptcha)
    expect(widget.props('refused')).toBe(false)
    expect(widget.text()).toContain('auth.captcha.asked')
  })

  it('shows the server text when the instance names no usable widget', async () => {
    rows.value = [{ config_key: 'signup_captcha_provider', config_value: 'off' }]
    register.mockRejectedValueOnce(ask())
    await mountRegister()
    await submit()
    expect(wrapper!.findComponent(SignupCaptcha).exists()).toBe(false)
    expect(wrapper!.get('[data-testid="auth-form-error"]').text()).toBe(ASKED)
  })

  it('leaves other refusals as they were', async () => {
    register.mockRejectedValueOnce(Object.assign(new Error('This email inbox has reached the limit of accounts on this instance.'), { status: 422 }))
    await mountRegister()
    await submit()
    expect(wrapper!.findComponent(SignupCaptcha).exists()).toBe(false)
    expect(wrapper!.get('[data-testid="auth-form-error"]').text()).toBe('auth.signupRefused.mailboxCap')
  })
})
