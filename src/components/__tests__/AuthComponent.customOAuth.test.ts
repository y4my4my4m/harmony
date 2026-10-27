/**
 * AuthComponent.vue and instance_config.custom_oauth_providers: the instance's own sign-in
 * providers appear after the built-in buttons with the same style, and start GoTrue's
 * authorize flow with their custom:<slug> identifier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { rows, sb } = vi.hoisted(() => {
  const rows: { value: Array<{ config_key: string; config_value: unknown }> } = { value: [] }
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: vi.fn(() => Promise.resolve({ data: rows.value, error: null })),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    rows,
    sb: {
      from: vi.fn(() => chain),
      chain,
      auth: {
        signOut: vi.fn().mockResolvedValue({ error: null }),
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        signInWithOAuth: vi.fn().mockResolvedValue({ data: { url: 'https://db.example.com/auth/v1/authorize' }, error: null }),
      },
    },
  }
})

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.name ?? params.provider}` : key) }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: {} }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ _pendingMFAVerification: false, session: null }) }))
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

let wrapper: VueWrapper | null = null

async function mountAuth() {
  wrapper = mount(AuthComponent, {
    props: { isLogin: true },
    attachTo: document.body,
    global: {
      mocks: { $t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.name ?? params.provider}` : key) },
      stubs: { 'i18n-t': true },
    },
  })
  await flushPromises()
  return wrapper
}

describe('AuthComponent custom OAuth providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rows.value = []
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('reads both provider keys of instance_config in one request', async () => {
    await mountAuth()
    expect(sb.from).toHaveBeenCalledWith('instance_config')
    expect(sb.chain.in).toHaveBeenCalledWith('config_key', ['oauth_providers', 'custom_oauth_providers'])
  })

  it('shows no OAuth section and no divider without providers', async () => {
    const w = await mountAuth()
    expect(w.find('.oauth-section').exists()).toBe(false)
    expect(w.find('.divider').exists()).toBe(false)
  })

  it('lists custom providers after the built-in ones, in the same button style', async () => {
    rows.value = [
      { config_key: 'oauth_providers', config_value: ['github'] },
      {
        config_key: 'custom_oauth_providers',
        config_value: [
          { id: 'custom:authentik', name: 'Authentik', icon: 'https://auth.example.com/icon.png' },
          { id: 'custom:better-auth', name: 'Better Auth' },
          { id: 'not-custom', name: 'Dropped' },
        ],
      },
    ]
    const w = await mountAuth()
    const buttons = w.findAll('.oauth-section button.oauth-btn')
    expect(buttons.map((b) => b.text())).toEqual([
      'auth.oauth.github',
      'auth.oauth.custom:Authentik',
      'auth.oauth.custom:Better Auth',
    ])
    expect(buttons[1].attributes('data-provider')).toBe('custom:authentik')
    expect(buttons[1].find('img').attributes('src')).toBe('https://auth.example.com/icon.png')
    expect(buttons[1].find('img').attributes('alt')).toBe('')
    expect(buttons[2].find('img').exists()).toBe(false)
    expect(buttons[2].find('svg').exists()).toBe(true)
    expect(w.find('.divider').exists()).toBe(true)
  })

  it('shows custom providers when no built-in provider is on', async () => {
    rows.value = [{ config_key: 'custom_oauth_providers', config_value: [{ id: 'custom:dex', name: 'Dex' }] }]
    const w = await mountAuth()
    expect(w.findAll('.oauth-section button').map((b) => b.text())).toEqual(['auth.oauth.custom:Dex'])
  })

  it('signs in through GoTrue with the custom identifier', async () => {
    rows.value = [{ config_key: 'custom_oauth_providers', config_value: [{ id: 'custom:dex', name: 'Dex' }] }]
    const w = await mountAuth()
    await w.find('[data-provider="custom:dex"]').trigger('click')
    await flushPromises()
    expect(sb.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'custom:dex',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        skipBrowserRedirect: false,
        queryParams: undefined,
      },
    })
  })

  it('names the provider in the error of a failed start', async () => {
    rows.value = [{ config_key: 'custom_oauth_providers', config_value: [{ id: 'custom:dex', name: 'Dex' }] }]
    sb.auth.signInWithOAuth.mockResolvedValueOnce({ data: null, error: { message: '' } })
    const w = await mountAuth()
    await w.find('[data-provider="custom:dex"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('auth.errors.oauthFailed:Dex')
  })
})
