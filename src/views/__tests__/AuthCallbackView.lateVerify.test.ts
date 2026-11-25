/**
 * AuthCallbackView.vue: an OAuth sign-in held at its second factor. A code verified after the
 * sign-in timeout finishes the sign-in in the auth store; the challenge then completes as for a
 * verification answered in time and the app opens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { push, sb } = vi.hoisted(() => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: { id: 'p-1', username: 'oauth', is_suspended: false }, error: null }),
  }
  return {
    push: vi.fn(),
    sb: {
      from: vi.fn(() => chain),
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'header.eyJhYWwiOiJhYWwxIn0.sig', user: { id: 'oauth-user', identities: [] } } },
          error: null,
        }),
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { totp: [{ id: 'factor-1', status: 'verified' }] }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: 'challenge-1' }, error: null }),
        },
      },
    },
  }
})

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => ({ query: {} }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ warning: vi.fn(), error: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: sb, signOutAndForget: vi.fn(), signOutEverywhere: vi.fn() }))
vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => false }))
vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    _pendingMFAVerification: true,
    isLoggedIn: false,
    session: null as unknown,
    validateSessionForMFA: vi.fn().mockResolvedValue(false),
    verify2FA: vi.fn().mockRejectedValue(new Error('MFA verification timed out. Please try logging in again.')),
    completeRecoverySignIn: vi.fn(),
    cancelPendingSignIn: vi.fn(),
  })
  return { useAuthStore: () => store }
})

import AuthCallbackView from '@/views/AuthCallbackView.vue'
import { useAuthStore } from '@/stores/auth'

let wrapper: VueWrapper | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('AuthCallbackView second factor after a timeout', () => {
  it('opens the app when the timed-out code finishes the sign-in', async () => {
    const store = useAuthStore() as any
    wrapper = mount(AuthCallbackView, { attachTo: document.body, global: { mocks: { $t: (key: string) => key } } })
    await flushPromises()
    const input = wrapper.get('input.code-input')

    await input.setValue('123456')
    await wrapper.get('form.mfa-form').trigger('submit')
    await flushPromises()
    expect(store.verify2FA).toHaveBeenCalledWith('factor-1', 'challenge-1', '123456')
    expect(wrapper.get('[role="alert"]').text()).not.toBe('')

    store.session = { access_token: 'x', user: { id: 'oauth-user' } }
    store.isLoggedIn = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(push).toHaveBeenCalledWith('/chat')
  })
})
