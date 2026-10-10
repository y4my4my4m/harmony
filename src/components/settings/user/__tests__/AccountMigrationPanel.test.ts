/**
 * Settings > Advanced > Account migration: aliases, the move check that gates the Move
 * button on the target listing this account, the step-up before begin_account_move, and the
 * moved state with its Cancel redirect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AccountMigrationPanel from '../AccountMigrationPanel.vue'

const { service, toast, push, session } = vi.hoisted(() => ({
  service: {
    loadState: vi.fn(),
    addAlias: vi.fn(),
    removeAlias: vi.fn(),
    previewMove: vi.fn(),
    moveAccount: vi.fn(),
    cancelRedirect: vi.fn(),
    isMfaEnabled: vi.fn(),
    verifyMfaCode: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  push: vi.fn(),
  session: { value: { user: { app_metadata: { providers: ['email'] } } } as any },
}))

vi.mock('@/services/AccountMigrationService', () => ({ accountMigrationService: service }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ get session() { return session.value } }) }))
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', render: () => h('span') }) }
})
vi.mock('@/components/common/Avatar.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'AvatarStub', render: () => h('span') }) }
})

const OLD_ALIAS = {
  id: 'p-old', uri: 'https://old.test/users/me', handle: '@me@old.test', routeHandle: 'me@old.test',
  displayName: 'Old me', avatarUrl: null, isLocal: false,
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    profileId: 'p-me',
    actorUri: 'https://harmony.test/users/me',
    handle: '@me@harmony.test',
    aliases: [OLD_ALIAS],
    movedTo: null,
    movedAt: null,
    ownedServers: [],
    ...overrides,
  }
}

const TARGET = {
  id: 'p-new', username: 'me', domain: 'new.test', is_local: false, display_name: 'New me',
  avatar_url: null, uri: 'https://new.test/users/me', locked: false,
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    preview: { target: TARGET, isSelf: false, aliasConfirmed: true, targetMoved: false, aliasUri: 'https://harmony.test/users/me', ...overrides },
  }
}

async function mountPanel() {
  const wrapper = mount(AccountMigrationPanel, {
    global: { stubs: { teleport: true, 'i18n-t': true } },
  })
  await flushPromises()
  return wrapper
}

async function checkTarget(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  await wrapper.find('[data-testid="am-target-input"]').setValue('me@new.test')
  await wrapper.find('[data-testid="am-target-input"]').element.closest('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  session.value = { user: { app_metadata: { providers: ['email'] } } }
  service.loadState.mockResolvedValue(state())
  service.isMfaEnabled.mockResolvedValue(false)
  service.verifyMfaCode.mockResolvedValue(null)
  service.previewMove.mockResolvedValue(preview())
  service.moveAccount.mockResolvedValue({ ok: true, migration_id: 'm-1', target: TARGET })
  service.cancelRedirect.mockResolvedValue({ ok: true })
  service.addAlias.mockResolvedValue({ ok: true, aliases: [] })
})

describe('AccountMigrationPanel', () => {
  it('lists aliases and the handle to enter on the other server', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="am-aliases"]').text()).toContain('@me@old.test')
    expect(wrapper.text()).toContain('@me@harmony.test')
  })

  it('adds an alias by handle and reloads', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="am-alias-input"]').setValue('  me@other.test ')
    await wrapper.find('[data-testid="am-alias-input"]').element.closest('form')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(service.addAlias).toHaveBeenCalledWith('me@other.test')
    expect(service.loadState).toHaveBeenCalledTimes(2)
  })

  it('shows a refused alias as an error', async () => {
    service.addAlias.mockResolvedValue({ ok: false, error: 'account_not_found' })
    const wrapper = await mountPanel()
    await wrapper.find('[data-testid="am-alias-input"]').setValue('ghost@nowhere.test')
    await wrapper.find('[data-testid="am-alias-input"]').element.closest('form')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toBe('accountMigration.errors.account_not_found')
  })

  it('keeps Move disabled until the target lists this account', async () => {
    service.previewMove.mockResolvedValue(preview({ aliasConfirmed: false }))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="am-start"]').attributes('disabled')).toBeDefined()
    await checkTarget(wrapper)
    expect(wrapper.find('[data-testid="am-alias-missing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="am-start"]').attributes('disabled')).toBeDefined()
  })

  it('moves after the password is entered', async () => {
    const wrapper = await mountPanel()
    await checkTarget(wrapper)
    expect(wrapper.find('[data-testid="am-alias-ok"]').exists()).toBe(true)
    await wrapper.find('[data-testid="am-start"]').trigger('click')
    await flushPromises()
    await wrapper.find('#am-password').setValue('hunter2')
    await wrapper.find('[data-testid="am-confirm"]').trigger('submit')
    await flushPromises()
    expect(service.verifyMfaCode).not.toHaveBeenCalled()
    expect(service.moveAccount).toHaveBeenCalledWith('me@new.test', 'hunter2')
    expect(toast.success).toHaveBeenCalled()
  })

  it('verifies the authenticator code first on a 2FA account', async () => {
    service.isMfaEnabled.mockResolvedValue(true)
    const wrapper = await mountPanel()
    await checkTarget(wrapper)
    await wrapper.find('[data-testid="am-start"]').trigger('click')
    await flushPromises()
    await wrapper.find('#am-password').setValue('hunter2')
    await wrapper.find('#am-mfa').setValue('123456')
    await wrapper.find('[data-testid="am-confirm"]').trigger('submit')
    await flushPromises()
    expect(service.verifyMfaCode).toHaveBeenCalledWith('123456')
    expect(service.verifyMfaCode.mock.invocationCallOrder[0]).toBeLessThan(service.moveAccount.mock.invocationCallOrder[0])
  })

  it('reports the cooldown in days', async () => {
    service.moveAccount.mockResolvedValue({ ok: false, error: 'move_cooldown', retryAfter: 3 * 86_400 })
    const wrapper = await mountPanel()
    await checkTarget(wrapper)
    await wrapper.find('[data-testid="am-start"]').trigger('click')
    await flushPromises()
    await wrapper.find('#am-password').setValue('hunter2')
    await wrapper.find('[data-testid="am-confirm"]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="am-confirm"] [role="alert"]').text()).toBe('accountMigration.errors.move_cooldown {"count":3}')
  })

  it('warns about owned servers', async () => {
    service.loadState.mockResolvedValue(state({ ownedServers: ['Book club'] }))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="am-owned"]').text()).toContain('Book club')
  })

  it('shows a moved account its redirect and cancels it', async () => {
    service.loadState.mockResolvedValue(state({
      movedTo: { ...OLD_ALIAS, handle: '@me@new.test' }, movedAt: '2026-10-01T00:00:00Z',
    }))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="am-moved"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="am-move"]').exists()).toBe(false)
    await wrapper.find('[data-testid="am-cancel"]').trigger('click')
    await flushPromises()
    expect(service.cancelRedirect).toHaveBeenCalled()
    expect(service.loadState).toHaveBeenCalledTimes(2)
  })
})
