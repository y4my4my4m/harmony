/**
 * ServerWelcomeSettings.vue: loads the screen, edits rules, and saves through
 * set_server_welcome with rules acceptance only when rules exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ServerWelcomeSettings from '../ServerWelcomeSettings.vue'
import { useServerWelcomeStore } from '@/stores/useServerWelcome'

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  api: { getServerWelcome: vi.fn(), setServerWelcome: vi.fn() },
}))

// Partial: the import graph reaches @/i18n (uploadValidation), which calls createI18n.
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/ServerWelcomeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ServerWelcomeService')>()
  return { ...actual, ...api }
})

const STATE = {
  server_id: 's1',
  name: 'Town Hall',
  description: null,
  icon: null,
  banner: null,
  is_local: true,
  configured: true,
  enabled: true,
  message: 'Hello',
  rules: [{ title: 'Be kind', description: '' }],
  require_acceptance: false,
  can_manage: true,
  is_member: true,
  joined_at: null,
  welcome_seen_at: null,
  rules_accepted_at: null,
  must_accept: false,
  should_show: false,
}

function mountSettings() {
  return mount(ServerWelcomeSettings, {
    props: { serverId: 's1' },
    global: {
      stubs: { Icon: true, LoadingSpinner: true, BaseModal: true, ServerWelcomeScreen: true },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  api.getServerWelcome.mockReset()
  api.setServerWelcome.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('ServerWelcomeSettings', () => {
  it('loads the current screen', async () => {
    api.getServerWelcome.mockResolvedValue(STATE)
    const w = mountSettings()
    await flushPromises()
    expect(api.getServerWelcome).toHaveBeenCalledWith('s1')
    expect((w.get('[data-testid="welcome-message"]').element as HTMLTextAreaElement).value).toBe('Hello')
    expect(w.findAll('[data-testid="welcome-rule-title"]')).toHaveLength(1)
    expect(w.get('[data-testid="welcome-save"]').attributes('disabled')).toBeDefined()
  })

  it('cannot require acceptance without rules', async () => {
    api.getServerWelcome.mockResolvedValue({ ...STATE, rules: [] })
    const w = mountSettings()
    await flushPromises()
    expect(w.get('[data-testid="welcome-require-acceptance"]').attributes('aria-disabled')).toBe('true')
  })

  it('saves added rules and the acceptance requirement', async () => {
    api.getServerWelcome.mockResolvedValue(STATE)
    const saved = { ...STATE, require_acceptance: true, rules: [...STATE.rules, { title: 'No spam', description: 'Ads go nowhere' }] }
    api.setServerWelcome.mockResolvedValue(saved)
    const w = mountSettings()
    await flushPromises()

    await w.get('[data-testid="welcome-add-rule"]').trigger('click')
    const titles = w.findAll('[data-testid="welcome-rule-title"]')
    await titles[1].setValue('No spam')
    await w.findAll('.rule-fields textarea')[1].setValue('Ads go nowhere')
    await w.get('[data-testid="welcome-require-acceptance"]').trigger('click')
    await w.get('[data-testid="welcome-save"]').trigger('click')
    await flushPromises()

    expect(api.setServerWelcome).toHaveBeenCalledWith('s1', {
      enabled: true,
      message: 'Hello',
      rules: [
        { title: 'Be kind', description: '' },
        { title: 'No spam', description: 'Ads go nowhere' },
      ],
      requireAcceptance: true,
    })
    expect(toast.success).toHaveBeenCalled()
    expect(useServerWelcomeStore().byServer.s1).toEqual(saved)
    expect(w.emitted('rules-saved')).toEqual([[['Be kind', 'No spam']]])
  })

  it('refuses a rule with details but no title', async () => {
    api.getServerWelcome.mockResolvedValue(STATE)
    const w = mountSettings()
    await flushPromises()
    await w.get('[data-testid="welcome-add-rule"]').trigger('click')
    await w.findAll('.rule-fields textarea')[1].setValue('details only')
    expect(w.get('[role="alert"]').text()).toBe('serverWelcome.settings.ruleNeedsTitle')
    expect(w.get('[data-testid="welcome-save"]').attributes('disabled')).toBeDefined()
  })

  it('reports a failed save', async () => {
    api.getServerWelcome.mockResolvedValue(STATE)
    api.setServerWelcome.mockRejectedValue(new Error('Missing permission: MANAGE_SERVER'))
    const w = mountSettings()
    await flushPromises()
    await w.get('[data-testid="welcome-message"]').setValue('Changed')
    await w.get('[data-testid="welcome-save"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Missing permission: MANAGE_SERVER')
  })
})
