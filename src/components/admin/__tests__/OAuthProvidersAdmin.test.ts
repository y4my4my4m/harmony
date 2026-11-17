/**
 * OAuthProvidersAdmin.vue: per-provider credentials of Admin, Authentication. The secret is
 * write-only, values the database would refuse are caught before the call, the status follows
 * the running sign-in service, and the button switch saves instance_config.oauth_providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { api, setConfig, toast, confirm, buttons } = vi.hoisted(() => ({
  api: {
    fetchCredentialsStatus: vi.fn(),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    fetchSignInServiceProviders: vi.fn(),
  },
  setConfig: vi.fn().mockResolvedValue(undefined),
  toast: { success: vi.fn(), error: vi.fn() },
  confirm: vi.fn().mockResolvedValue(true),
  buttons: { value: [] as unknown },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
    locale: { value: 'en' },
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'admin-auth-id' } } }) }))
vi.mock('@/services/AdminService', () => ({ adminService: { setInstanceConfig: setConfig } }))
vi.mock('@/services/runtimeConfig', () => ({ runtimeConfig: { supabaseUrl: 'https://db.chat.test/', supabaseAnonKey: 'anon' } }))
vi.mock('@/supabase', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: { config_value: buttons.value }, error: null }),
  }
  return { supabase: { from: () => chain } }
})
vi.mock('@/services/authProviderCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/authProviderCredentials')>()),
  ...api,
}))

import OAuthProvidersAdmin from '@/components/admin/OAuthProvidersAdmin.vue'

const writer = { seenAt: '2026-11-17T00:00:00Z', appliedAt: null, error: null, live: true }
const empty = { providers: {}, writer }
const discordSaved = {
  providers: { discord: { provider: 'discord', clientId: '123456789012345678', hasSecret: true, updatedAt: null } },
  writer,
}

let wrapper: VueWrapper | null = null

async function mountAdmin() {
  wrapper = mount(OAuthProvidersAdmin, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const card = (w: VueWrapper, p: string) => w.get(`[data-testid="sip-${p}"]`)

describe('OAuthProvidersAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buttons.value = []
    api.fetchCredentialsStatus.mockResolvedValue(empty)
    api.fetchSignInServiceProviders.mockResolvedValue({ google: false, twitch: false, github: false, discord: false })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.useRealTimers()
  })

  it('lists the four built-in providers with the callback URL', async () => {
    const w = await mountAdmin()
    expect(w.findAll('.sip-card').map((c) => c.attributes('data-testid'))).toEqual([
      'sip-google', 'sip-twitch', 'sip-github', 'sip-discord',
    ])
    expect(w.get('[data-testid="sip-callback"]').text()).toBe('https://db.chat.test/auth/v1/callback')
    expect(card(w, 'discord').get('[data-testid="sip-status"]').text()).toBe('admin.signInProviders.status.unset')
  })

  it('names a provider the server environment turned on', async () => {
    api.fetchSignInServiceProviders.mockResolvedValue({ google: true, discord: false })
    const w = await mountAdmin()
    expect(card(w, 'google').get('[data-testid="sip-status"]').text()).toBe('admin.signInProviders.status.server')
  })

  it('refuses a Discord client id that is not an application id, without a call', async () => {
    const w = await mountAdmin()
    const c = card(w, 'discord')
    await c.get('[data-testid="sip-client-id"]').setValue('my-app')
    await c.get('[data-testid="sip-secret"]').setValue('secret-value-1')
    await c.get('form').trigger('submit')
    await flushPromises()
    expect(api.saveCredentials).not.toHaveBeenCalled()
    expect(c.get('[data-testid="sip-problem"]').text()).toBe('admin.signInProviders.problem.discordId')
  })

  it('refuses a secret that could break into the configuration', async () => {
    const w = await mountAdmin()
    const c = card(w, 'google')
    await c.get('[data-testid="sip-client-id"]').setValue('abc.apps.googleusercontent.com')
    await c.get('[data-testid="sip-secret"]').setValue('bad secret"value')
    await c.get('form').trigger('submit')
    await flushPromises()
    expect(api.saveCredentials).not.toHaveBeenCalled()
    expect(c.get('[data-testid="sip-problem"]').text()).toBe('admin.signInProviders.problem.secret')
  })

  it('saves, then shows the secret as stored and never fills it back', async () => {
    api.saveCredentials.mockResolvedValue(discordSaved)
    const w = await mountAdmin()
    const c = card(w, 'discord')
    await c.get('[data-testid="sip-client-id"]').setValue(' 123456789012345678 ')
    await c.get('[data-testid="sip-secret"]').setValue('Secret_one-123')
    await c.get('form').trigger('submit')
    await flushPromises()
    expect(api.saveCredentials).toHaveBeenCalledWith('discord', ' 123456789012345678 ', 'Secret_one-123')
    const secret = c.get('[data-testid="sip-secret"]').element as HTMLInputElement
    expect(secret.value).toBe('')
    expect(secret.type).toBe('password')
    expect(secret.placeholder).toBe('admin.signInProviders.secretSaved')
    expect(w.html()).not.toContain('Secret_one-123')
    // Its button is off: the provider is off in the sign-in service.
    expect(c.get('[data-testid="sip-status"]').text()).toBe('admin.signInProviders.status.hidden')
  })

  it('a saved provider with its button on is applying until the sign-in service has it', async () => {
    buttons.value = ['discord']
    api.fetchCredentialsStatus.mockResolvedValue(discordSaved)
    api.fetchSignInServiceProviders.mockResolvedValueOnce({ discord: false })
    vi.useFakeTimers()
    const w = await mountAdmin()
    const status = card(w, 'discord').get('[data-testid="sip-status"]')
    expect(status.text()).toBe('admin.signInProviders.status.applying')
    api.fetchSignInServiceProviders.mockResolvedValue({ discord: true })
    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()
    expect(status.text()).toBe('admin.signInProviders.status.active')
  })

  it('the button switch saves the list in built-in order', async () => {
    buttons.value = ['github']
    const w = await mountAdmin()
    await card(w, 'discord').get('[data-testid="sip-button-toggle"]').setValue(true)
    await flushPromises()
    expect(setConfig).toHaveBeenCalledWith('oauth_providers', ['github', 'discord'], 'admin-auth-id', 'Enabled OAuth providers')
  })

  it('clears after confirmation', async () => {
    api.fetchCredentialsStatus.mockResolvedValue(discordSaved)
    api.clearCredentials.mockResolvedValue({
      providers: { discord: { provider: 'discord', clientId: null, hasSecret: false, updatedAt: null } },
      writer,
    })
    const w = await mountAdmin()
    await card(w, 'discord').get('[data-testid="sip-clear"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ dangerAction: true }))
    expect(api.clearCredentials).toHaveBeenCalledWith('discord')
    expect(card(w, 'discord').find('[data-testid="sip-clear"]').exists()).toBe(false)
    expect((card(w, 'discord').get('[data-testid="sip-client-id"]').element as HTMLInputElement).value).toBe('')
  })

  it('says when no federation server writes the sign-in service configuration', async () => {
    api.fetchCredentialsStatus.mockResolvedValue({ providers: {}, writer: { seenAt: null, appliedAt: null, error: null, live: false } })
    const w = await mountAdmin()
    expect(w.get('[data-testid="sip-writer-note"]').text()).toBe('admin.signInProviders.writerOff')
  })
})
