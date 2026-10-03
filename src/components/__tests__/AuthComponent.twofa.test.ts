/**
 * AuthComponent.vue: the sign-in second-factor dialog. A pending aal1 session ends only
 * through an explicit cancel, and ending it never reaches the account's other sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

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

async function mountAuth() {
  wrapper = mount(AuthComponent, {
    props: { isLogin: true },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

async function submitLogin(w: VueWrapper) {
  await w.find('input[type="email"]').setValue('mfa@example.com')
  await w.find('input[type="password"]').setValue('correct horse')
  await w.find('[data-testid="auth-form"]').trigger('submit')
  await flushPromises()
}

const dialog = () => document.body.querySelector('[data-testid="twofa-backdrop"]')

describe('AuthComponent second-factor dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authStore.login.mockResolvedValue({ requires2FA: true, factorId: 'factor-1', challengeId: 'challenge-1', session: null })
    authStore.cancelPendingSignIn.mockResolvedValue(undefined)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('stays open on a backdrop click and on Escape', async () => {
    const w = await mountAuth()
    await submitLogin(w)
    const backdrop = dialog() as HTMLElement
    expect(backdrop).not.toBeNull()

    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(dialog()).not.toBeNull()
    expect(authStore.cancelPendingSignIn).not.toHaveBeenCalled()
    expect(sb.auth.signOut).not.toHaveBeenCalled()
  })

  it('cancel ends the pending session locally and returns to the form', async () => {
    const w = await mountAuth()
    await submitLogin(w)

    ;(document.body.querySelector('[data-testid="twofa-cancel"]') as HTMLElement).click()
    await flushPromises()

    expect(dialog()).toBeNull()
    expect(authStore.cancelPendingSignIn).toHaveBeenCalledTimes(1)
    expect(sb.auth.signOut).not.toHaveBeenCalled()
    expect(w.find('[data-testid="auth-form"]').exists()).toBe(true)
  })

  it('a second sign-in after cancel reopens the challenge without any sign-out', async () => {
    const w = await mountAuth()
    await submitLogin(w)
    ;(document.body.querySelector('[data-testid="twofa-close"]') as HTMLElement).click()
    await flushPromises()
    expect(dialog()).toBeNull()

    await submitLogin(w)

    expect(dialog()).not.toBeNull()
    expect(authStore.login).toHaveBeenCalledTimes(2)
    expect(authStore.cancelPendingSignIn).toHaveBeenCalledTimes(1)
    expect(sb.auth.signOut).not.toHaveBeenCalled()
  })
})
