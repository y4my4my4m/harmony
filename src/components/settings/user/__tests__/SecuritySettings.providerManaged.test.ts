/**
 * Settings > Security for an account GoTrue manages through its sign-in provider: the first
 * refusal (422 user_sso_managed) replaces the password form with a note naming the provider,
 * moves focus to it, and the account is remembered so the form is not offered again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const { updateUser, maybeSingle, toastError } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  maybeSingle: vi.fn(),
  toastError: vi.fn(),
}))

const translate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: translate, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: toastError }) }))
vi.mock('@/supabase', () => ({
  supabase: {
    auth: {
      updateUser,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
}))
vi.mock('@/services/AccountSecurityService', () => ({
  accountSecurityService: { verifyPassword: vi.fn() },
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
import { useAuthStore } from '@/stores/auth'

const USER_ID = '00000000-0000-4000-8000-0000000000aa'
const REFUSAL = {
  code: 'user_sso_managed',
  status: 422,
  message: 'Updating email, phone, password of a SSO account only possible via SSO',
}

let wrapper: VueWrapper

function mountAs(providers: string[]) {
  const store = useAuthStore()
  store.session = {
    access_token: 'token',
    user: { id: USER_ID, email: 'apart@test.local', app_metadata: { providers } },
  } as unknown as typeof store.session
  wrapper = mount(SecuritySettings, {
    attachTo: document.body,
    global: { mocks: { $t: translate } },
  })
}

async function submitNewPassword() {
  await wrapper.get('#new-password').setValue('long enough one')
  await wrapper.get('#confirm-password').setValue('long enough one')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  updateUser.mockReset()
  toastError.mockReset()
  maybeSingle.mockReset()
  maybeSingle.mockResolvedValue({ data: { config_value: [{ id: 'custom:authentik', name: 'Example SSO' }] } })
})

afterEach(() => wrapper.unmount())

describe('SecuritySettings for a provider-managed account', () => {
  it('replaces the form with a note naming the provider once GoTrue refuses', async () => {
    updateUser.mockResolvedValue({ data: null, error: REFUSAL })
    mountAs(['custom:authentik'])
    await flushPromises()
    await submitNewPassword()

    expect(wrapper.find('form').exists()).toBe(false)
    const note = wrapper.get('[data-testid="password-provider-managed"]')
    expect(note.text()).toBe('security.password.providerManaged {"providers":"Example SSO"}')
    expect(document.activeElement).toBe(note.element)
    expect(toastError).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('harmony.security.providerManaged')!)).toEqual([USER_ID])
  })

  it('offers no form to an account already refused on this device', async () => {
    localStorage.setItem('harmony.security.providerManaged', JSON.stringify([USER_ID]))
    mountAs(['github'])
    await flushPromises()
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('[data-testid="password-provider-managed"]').text())
      .toBe('security.password.providerManaged {"providers":"GitHub"}')
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('control: another refusal keeps the form and reports through a toast', async () => {
    updateUser.mockResolvedValue({ data: null, error: { code: 'unexpected_failure', status: 500, message: 'boom' } })
    mountAs(['custom:authentik'])
    await flushPromises()
    await submitNewPassword()

    expect(wrapper.find('form').exists()).toBe(true)
    expect(wrapper.find('[data-testid="password-provider-managed"]').exists()).toBe(false)
    expect(toastError).toHaveBeenCalledWith('security.password.changeFailed')
    expect(localStorage.getItem('harmony.security.providerManaged')).toBeNull()
  })
})
