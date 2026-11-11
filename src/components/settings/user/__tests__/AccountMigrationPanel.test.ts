/**
 * Settings > Advanced > Account migration: aliases, the move check that gates the Move
 * button on the target listing this account, the step-up before begin_account_move, the
 * moved state with its Cancel redirect, what stays behind, following import and profile copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AccountMigrationPanel from '../AccountMigrationPanel.vue'

const { service, toast, push, session, capability, store, broadcast } = vi.hoisted(() => ({
  service: {
    loadState: vi.fn(),
    addAlias: vi.fn(),
    removeAlias: vi.fn(),
    previewMove: vi.fn(),
    moveAccount: vi.fn(),
    cancelRedirect: vi.fn(),
    isMfaEnabled: vi.fn(),
    verifyMfaCode: vi.fn(),
    getFollowingImport: vi.fn(),
    startFollowingImport: vi.fn(),
    cancelFollowingImport: vi.fn(),
    copyProfile: vi.fn(),
  },
  capability: { value: true },
  store: { profile: { display_name: 'Mine' } as Record<string, unknown> | null },
  broadcast: vi.fn(),
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
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => store }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ updateCurrentUserProfile: broadcast }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => capability.value }))
vi.mock('@/utils/bannerUtils', () => ({ getBannerUrl: (url: string | null) => url }))
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

const PROFILE = {
  display_name: 'New name', bio: null, avatar_url: 'me/avatar.png', banner_url: null,
  profile_fields: [],
}

const ORIGIN = {
  id: 'p-old', handle: '@me@old.test', display_name: 'Old name', bio: 'Old bio',
  avatar_url: 'https://old.test/a.png', banner_url: 'https://old.test/b.png',
  profile_fields: [{ name: 'Blog', value: '<a href="https://blog.test">https://blog.test</a>' }, { name: 'Tea', value: 'green &amp; black' }],
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
    profile: PROFILE,
    movedFrom: [],
    ...overrides,
  }
}

const IMPORT = {
  id: 'i-1', source: 'mastodon_csv', total: 3, created_at: '2026-11-09T00:00:00Z', finished_at: null,
  cancelled: false, retry_after: null,
  counts: { followed: 1, requested: 1, already_following: 0, already_requested: 0, failed: 1, cancelled: 0 },
  failures: [{ handle: 'gone@far.test', reason: 'not_found' }],
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

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  capability.value = true
  store.profile = { display_name: 'Mine' }
  service.getFollowingImport.mockResolvedValue(null)
  service.startFollowingImport.mockResolvedValue({ ok: true, total: 2 })
  service.cancelFollowingImport.mockResolvedValue({ ok: true })
  service.copyProfile.mockResolvedValue({ ok: true, copied: ['bio'], failed: [], update: { bio: 'Old bio' } })
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

  it('lists all of what stays behind', async () => {
    const wrapper = await mountPanel()
    const columns = wrapper.find('.am-columns').text()
    for (const key of ['Posts', 'Interactions', 'Profile', 'Following', 'Blocks', 'Keys', 'Bots', 'Servers']) {
      expect(columns).toContain(`accountMigration.move.stays${key}`)
    }
  })

  describe('following import', () => {
    const csv = (name = 'following_accounts.csv') =>
      new File(['Account address,Show boosts\nalice@far.test,true\nbob@far.test,true\n'], name, { type: 'text/csv' })

    async function pickFile(wrapper: Awaited<ReturnType<typeof mountPanel>>, file: File) {
      const input = wrapper.find('[data-testid="am-import-file"]')
      Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
      await input.trigger('change')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="am-import-preview"], [data-testid="am-import-error"]').exists()).toBe(true)
      })
    }

    it('shows what a file holds and starts nothing until asked', async () => {
      const wrapper = await mountPanel()
      await pickFile(wrapper, csv())
      expect(wrapper.find('[data-testid="am-import-preview"]').text()).toContain('"count":2')
      expect(service.startFollowingImport).not.toHaveBeenCalled()
    })

    it('sends the handles when started and then follows the job', async () => {
      const wrapper = await mountPanel()
      await pickFile(wrapper, csv())
      service.getFollowingImport.mockResolvedValue({ ...IMPORT, finished_at: '2026-11-09T01:00:00Z' })
      await wrapper.find('[data-testid="am-import-start"]').trigger('click')
      await flushPromises()
      expect(service.startFollowingImport).toHaveBeenCalledWith(['alice@far.test', 'bob@far.test'], 'mastodon_csv')
      expect(wrapper.find('[data-testid="am-import-preview"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="am-import-status"]').text()).toBe('accountMigration.import.finished')
    })

    it('shows a refused file and starts nothing', async () => {
      const wrapper = await mountPanel()
      await pickFile(wrapper, csv('blocked_accounts.csv'))
      expect(wrapper.find('[data-testid="am-import-error"]').text()).toBe('accountMigration.import.fileErrors.wrong_list')
      expect(wrapper.find('[data-testid="am-import-preview"]').exists()).toBe(false)
    })

    it('shows a refusal from the server', async () => {
      service.startFollowingImport.mockResolvedValue({ ok: false, error: 'import_rate_limited', retryAfter: 7200 })
      const wrapper = await mountPanel()
      await pickFile(wrapper, csv())
      await wrapper.find('[data-testid="am-import-start"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="am-import-error"]').text()).toContain('accountMigration.errors.import_rate_limited {"count":2}')
    })

    it('shows the result with each failure named', async () => {
      service.getFollowingImport.mockResolvedValue({ ...IMPORT, finished_at: '2026-11-09T01:00:00Z' })
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-import-count-followed"]').text()).toBe('1')
      expect(wrapper.find('[data-testid="am-import-count-requested"]').text()).toBe('1')
      expect(wrapper.find('[data-testid="am-import-count-failed"]').text()).toBe('1')
      const failures = wrapper.find('[data-testid="am-import-failures"]').text()
      expect(failures).toContain('gone@far.test')
      expect(failures).toContain('accountMigration.import.reasons.not_found')
    })

    it('reads an unknown failure as unreachable rather than a raw key', async () => {
      service.getFollowingImport.mockResolvedValue({
        ...IMPORT, finished_at: '2026-11-09T01:00:00Z', failures: [{ handle: 'x@y.test', reason: 'something_new' }],
      })
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-import-failures"]').text()).toContain('accountMigration.import.reasons.unreachable')
    })

    it('polls while running, says when the limit holds it, and stops polling when unmounted', async () => {
      vi.useFakeTimers()
      service.getFollowingImport.mockResolvedValue({ ...IMPORT, retry_after: 610 })
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-import-status"]').text()).toContain('accountMigration.import.running')
      expect(wrapper.find('[data-testid="am-import-waiting"]').text()).toContain('"count":11')
      expect(wrapper.find('[data-testid="am-import-file"]').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(3000)
      expect(service.getFollowingImport).toHaveBeenCalledTimes(2)

      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(9000)
      expect(service.getFollowingImport).toHaveBeenCalledTimes(2)
    })

    it('stops polling once the import finishes', async () => {
      vi.useFakeTimers()
      service.getFollowingImport.mockResolvedValueOnce(IMPORT)
      service.getFollowingImport.mockResolvedValue({ ...IMPORT, finished_at: '2026-11-09T01:00:00Z' })
      const wrapper = await mountPanel()
      await vi.advanceTimersByTimeAsync(9000)
      expect(service.getFollowingImport).toHaveBeenCalledTimes(2)
      expect(wrapper.find('[data-testid="am-import-cancel"]').exists()).toBe(false)
    })

    it('stops a running import', async () => {
      service.getFollowingImport.mockResolvedValueOnce(IMPORT)
      service.getFollowingImport.mockResolvedValue({ ...IMPORT, finished_at: '2026-11-09T01:00:00Z', cancelled: true })
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-import-cancel"]').trigger('click')
      await flushPromises()
      expect(service.cancelFollowingImport).toHaveBeenCalled()
      expect(wrapper.find('[data-testid="am-import-status"]').text()).toBe('accountMigration.import.stopped')
    })

    it('is not offered on a moved account', async () => {
      service.loadState.mockResolvedValue(state({ movedTo: { ...OLD_ALIAS, handle: '@me@new.test' }, movedAt: '2026-10-01T00:00:00Z' }))
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-import"]').exists()).toBe(false)
    })
  })

  describe('copying the old profile', () => {
    const withOrigin = (overrides: Record<string, unknown> = {}) =>
      service.loadState.mockResolvedValue(state({ movedFrom: [ORIGIN], ...overrides }))

    it('is not offered without a confirmed move', async () => {
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-copy"]').exists()).toBe(false)
    })

    it('starts with nothing picked and no way to run', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      for (const field of ['display_name', 'bio', 'avatar', 'banner', 'profile_fields']) {
        expect((wrapper.find(`[data-testid="am-copy-${field}"]`).element as HTMLInputElement).checked).toBe(false)
      }
      expect((wrapper.find('[data-testid="am-copy-open"]').element as HTMLButtonElement).disabled).toBe(true)
    })

    it('says which fields add and which replace', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-copy-row-display_name"]').text()).toContain('accountMigration.copy.replaces')
      expect(wrapper.find('[data-testid="am-copy-row-bio"]').text()).toContain('accountMigration.copy.adds')
      expect(wrapper.find('[data-testid="am-copy-row-avatar"]').text()).toContain('accountMigration.copy.replaces')
      expect(wrapper.find('[data-testid="am-copy-row-banner"]').text()).toContain('accountMigration.copy.adds')
    })

    it('takes the default avatar as none on both accounts', async () => {
      withOrigin({ profile: { ...PROFILE, avatar_url: '/default_avatar.webp' } })
      const adding = await mountPanel()
      expect(adding.find('[data-testid="am-copy-row-avatar"]').text()).toContain('accountMigration.copy.adds')

      withOrigin({ movedFrom: [{ ...ORIGIN, avatar_url: '/default_avatar.webp' }] })
      const none = await mountPanel()
      expect(none.find('[data-testid="am-copy-row-avatar"]').exists()).toBe(false)
    })

    it('shows field values as text, whatever markup they hold', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      const row = wrapper.find('[data-testid="am-copy-row-profile_fields"]')
      expect(row.text()).toContain('Blog: https://blog.test')
      expect(row.text()).toContain('Tea: green & black')
      expect(row.html()).not.toContain('<a ')
    })

    it('offers no row for what the old account left empty', async () => {
      withOrigin({ movedFrom: [{ ...ORIGIN, bio: '   ', banner_url: null, profile_fields: [] }] })
      const wrapper = await mountPanel()
      expect(wrapper.find('[data-testid="am-copy-row-bio"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="am-copy-row-banner"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="am-copy-row-profile_fields"]').exists()).toBe(false)
    })

    it('cannot pick a text field that already matches', async () => {
      withOrigin({ profile: { ...PROFILE, display_name: 'Old name' } })
      const wrapper = await mountPanel()
      expect((wrapper.find('[data-testid="am-copy-display_name"]').element as HTMLInputElement).disabled).toBe(true)
      expect(wrapper.find('[data-testid="am-copy-row-display_name"]').text()).toContain('accountMigration.copy.same')
    })

    it('copies nothing until the confirmation, and warns when something is replaced', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-display_name"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-open"]').trigger('click')
      expect(service.copyProfile).not.toHaveBeenCalled()
      const dialog = wrapper.find('[data-testid="am-copy-confirm"]')
      expect(dialog.text()).toContain('accountMigration.copy.confirmReplaces')
      expect(dialog.text()).toContain('accountMigration.copy.confirmWarning')

      await dialog.findAll('button')[0].trigger('click')
      expect(wrapper.find('[data-testid="am-copy-confirm"]').exists()).toBe(false)
      expect(service.copyProfile).not.toHaveBeenCalled()
    })

    it('does not warn when nothing is replaced', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-bio"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-open"]').trigger('click')
      expect(wrapper.find('[data-testid="am-copy-confirm"]').text()).not.toContain('accountMigration.copy.confirmWarning')
    })

    it('copies the picked fields and updates the stored profile', async () => {
      withOrigin()
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-bio"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-open"]').trigger('click')
      await wrapper.find('[data-testid="am-copy-confirm"]').trigger('submit')
      await flushPromises()

      expect(service.copyProfile).toHaveBeenCalledWith('p-old', ['bio'])
      expect(store.profile).toMatchObject({ display_name: 'Mine', bio: 'Old bio' })
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ bio: 'Old bio' }))
      expect(toast.success).toHaveBeenCalledWith('accountMigration.copy.done')
      expect(wrapper.find('[data-testid="am-copy-confirm"]').exists()).toBe(false)
      expect(service.loadState).toHaveBeenCalledTimes(2)
    })

    it('names an image that could not be read and keeps the rest', async () => {
      withOrigin()
      service.copyProfile.mockResolvedValue({ ok: true, copied: ['bio'], failed: ['avatar'], update: { bio: 'Old bio' } })
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-bio"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-avatar"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-open"]').trigger('click')
      await wrapper.find('[data-testid="am-copy-confirm"]').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[data-testid="am-copy"] [role="alert"]').text()).toContain('accountMigration.copy.partial')
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('keeps the dialog open and shows why when the server refuses', async () => {
      withOrigin()
      service.copyProfile.mockResolvedValue({ ok: false, error: 'not_verified' })
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-bio"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-open"]').trigger('click')
      await wrapper.find('[data-testid="am-copy-confirm"]').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[data-testid="am-copy-confirm"] [role="alert"]').text()).toBe('accountMigration.errors.not_verified')
      expect(store.profile).toEqual({ display_name: 'Mine' })
    })

    it('lets the person pick between two moved accounts, and resets the picks', async () => {
      withOrigin({ movedFrom: [ORIGIN, { ...ORIGIN, id: 'p-older', handle: '@me@older.test' }] })
      const wrapper = await mountPanel()
      await wrapper.find('[data-testid="am-copy-bio"]').setValue(true)
      await wrapper.find('[data-testid="am-copy-origin"]').setValue('p-older')
      expect(wrapper.find('[data-testid="am-copy"]').text()).toContain('@me@older.test')
      expect((wrapper.find('[data-testid="am-copy-bio"]').element as HTMLInputElement).checked).toBe(false)
    })
  })

  it('hides import and copy from a native app on an instance without them', async () => {
    capability.value = false
    service.loadState.mockResolvedValue(state({ movedFrom: [ORIGIN] }))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="am-import"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="am-copy"]').exists()).toBe(false)
    expect(service.getFollowingImport).not.toHaveBeenCalled()
  })
})
