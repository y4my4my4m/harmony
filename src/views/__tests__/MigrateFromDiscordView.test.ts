/**
 * /migrate/<token>: landing, error, claim result and new-account states, driven by the query string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

enableAutoUnmount(afterEach)

const h = vi.hoisted(() => {
  class DiscordMigrationError extends Error {
    code: string
    constructor(code: string) { super(code); this.code = code }
  }
  return {
    DiscordMigrationError,
    svc: {
      preview: vi.fn(),
      startDiscordSignIn: vi.fn(),
      createAccount: vi.fn(),
      claim: vi.fn(),
      saveSyncChoice: vi.fn(),
      myLink: vi.fn(),
      setMySync: vi.fn(async () => {}),
      requestMySync: vi.fn(),
    },
    route: { params: { token: 'tok' } as Record<string, string>, query: {} as Record<string, string>, fullPath: '/migrate/tok' },
    router: { push: vi.fn(), replace: vi.fn() },
    auth: { isLoggedIn: false, session: null as any, login: vi.fn(), logout: vi.fn() },
    profile: { profile: null as any },
    serverStore: { setCurrentServer: vi.fn(), fetchServersForUser: vi.fn() },
    profileId: vi.fn(),
  }
})

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('vue-router', () => ({
  useRoute: () => h.route,
  useRouter: () => h.router,
  RouterLink: { props: ['to'], template: '<a :href="typeof to === \'string\' ? to : \'\'"><slot /></a>' },
}))
vi.mock('@/stores/auth', async () => {
  const { reactive } = await import('vue')
  h.auth = reactive(h.auth)
  return { useAuthStore: () => h.auth }
})
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => h.serverStore }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { getCurrentProfileId: () => h.profileId() } }))
vi.mock('@/stores/useProfile', async () => {
  const { reactive } = await import('vue')
  h.profile = reactive(h.profile)
  return { useProfileStore: () => h.profile }
})
vi.mock('@/services/discordMigrationService', () => ({
  ...h.svc,
  DiscordMigrationError: h.DiscordMigrationError,
}))

import MigrateFromDiscordView from '../MigrateFromDiscordView.vue'

async function open(query: Record<string, string> = {}) {
  h.route.query = query
  const wrapper = mount(MigrateFromDiscordView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  Object.values(h.svc).forEach(fn => (fn as any).mockReset?.())
  h.svc.preview.mockResolvedValue({ serverId: 'srv', serverName: 'Lobby', iconUrl: null })
  h.svc.setMySync.mockResolvedValue(undefined)
  h.svc.myLink.mockResolvedValue(null)
  h.auth.isLoggedIn = false
  h.auth.session = null
  h.profile.profile = null
  h.router.replace.mockReset()
  h.auth.login.mockReset()
})

describe('MigrateFromDiscordView', () => {
  it('Open the server reloads the server list before routing to chat', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: [] })
    h.profileId.mockResolvedValue('prof-1')
    h.router.push.mockReset()
    h.serverStore.setCurrentServer.mockReset()
    let release!: () => void
    h.serverStore.fetchServersForUser.mockReset()
    h.serverStore.fetchServersForUser.mockImplementation(() => new Promise<void>((r) => { release = r }))
    const wrapper = await open({ ticket: 'tkt' })
    await wrapper.get('[data-testid="migrate-open-server"]').trigger('click')
    await flushPromises()
    expect(h.serverStore.fetchServersForUser).toHaveBeenCalledWith('prof-1', true)
    expect(h.router.push).not.toHaveBeenCalled()
    release()
    await flushPromises()
    expect(h.serverStore.setCurrentServer).toHaveBeenCalledWith('srv')
    expect(h.router.push).toHaveBeenCalledWith({ name: 'Chat' })
  })

  it('signed out with no ticket offers both ways in', async () => {
    const wrapper = await open()
    expect(wrapper.text()).toContain('Lobby')
    expect(wrapper.find('[data-testid="migrate-have-account"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="migrate-new-account"]').exists()).toBe(true)
    await wrapper.get('[data-testid="migrate-new-account"]').trigger('click')
    expect(h.svc.startDiscordSignIn).toHaveBeenCalledWith('tok')
  })

  it('signed in names the account the link goes to', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    const wrapper = await open()
    expect(wrapper.text()).toContain('"username":"alice"')
    expect(wrapper.find('[data-testid="migrate-signin-discord"]').exists()).toBe(true)
  })

  it('error=harmony_banned shows its message and no sign-in button', async () => {
    const wrapper = await open({ error: 'harmony_banned' })
    expect(wrapper.get('[data-testid="migrate-error"]').text()).toContain('discordMigration.migrate.errors.harmony_banned')
    expect(wrapper.find('[data-testid="migrate-new-account"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="migrate-signin-discord"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="migrate-restart"]').exists()).toBe(false)
  })

  it('error=ticket_expired offers to start again', async () => {
    const wrapper = await open({ error: 'ticket_expired' })
    await wrapper.get('[data-testid="migrate-restart"]').trigger('click')
    expect(h.svc.startDiscordSignIn).toHaveBeenCalledWith('tok')
  })

  it('an unknown error code reads as a generic failure', async () => {
    const wrapper = await open({ error: 'something_new' })
    expect(wrapper.get('[data-testid="migrate-error"]').text()).toContain('discordMigration.migrate.errors.unknown')
  })

  it('signed in with a ticket claims once and lists the roles received', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: ['Mod', 'Artist'] })
    const wrapper = await open({ ticket: 'tkt' })
    expect(h.svc.claim).toHaveBeenCalledTimes(1)
    expect(h.svc.claim).toHaveBeenCalledWith('tkt')
    expect(wrapper.get('[data-testid="migrate-roles"]').text()).toContain('Mod')
    expect(wrapper.get('[data-testid="migrate-roles"]').text()).toContain('Artist')
    expect(wrapper.find('[data-testid="sync-avatar"]').exists()).toBe(true)
  })

  it('tells the server owner that roles are only added', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: ['Mod'], isOwner: true })
    const wrapper = await open({ ticket: 'tkt' })
    expect(wrapper.get('[data-testid="migrate-owner-roles"]').text()).toContain('discordMigration.migrate.ownerRoles')
  })

  it('says nothing about owner roles to other members', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'bob', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: ['Mod'], isOwner: false })
    const wrapper = await open({ ticket: 'tkt' })
    expect(wrapper.find('[data-testid="migrate-owner-roles"]').exists()).toBe(false)
  })

  it('asks the gateway for a fresh sync after a successful claim, whatever the toggles', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: [] })
    await open({ ticket: 'tkt' })
    expect(h.svc.requestMySync).toHaveBeenCalledTimes(1)
    expect(h.svc.requestMySync).toHaveBeenCalledWith('srv')
  })

  it('does not ask for a sync when the claim is refused', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockRejectedValue(new h.DiscordMigrationError('kicked_on_harmony'))
    await open({ ticket: 'tkt' })
    expect(h.svc.requestMySync).not.toHaveBeenCalled()
  })

  it('takes the ticket and username out of the address but keeps them for the form', async () => {
    const wrapper = await open({ ticket: 'tkt', username: 'dave_d' })
    expect(h.router.replace).toHaveBeenCalledWith({ path: '/migrate/tok', query: {} })
    expect((wrapper.get('[data-testid="migrate-username"]').element as HTMLInputElement).value).toBe('dave_d')
    expect(wrapper.find('[data-testid="migrate-form"]').exists()).toBe(true)
  })

  it('still claims the ticket it took out of the address', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockResolvedValue({ serverId: 'srv', rolesGranted: [] })
    await open({ ticket: 'tkt' })
    expect(h.router.replace).toHaveBeenCalledWith({ path: '/migrate/tok', query: {} })
    expect(h.svc.claim).toHaveBeenCalledWith('tkt')
  })

  it('leaves the address alone when it holds no ticket or username', async () => {
    await open({ error: 'denied' })
    expect(h.router.replace).not.toHaveBeenCalled()
  })

  it('email_exists offers to sign in instead and says to choose Discord again afterwards', async () => {
    h.svc.createAccount.mockRejectedValue(new h.DiscordMigrationError('email_exists'))
    const wrapper = await open({ ticket: 'tkt' })
    await wrapper.get('[data-testid="migrate-username"]').setValue('newbie')
    await wrapper.get('[data-testid="migrate-email"]').setValue('n@example.com')
    await wrapper.get('[data-testid="migrate-password"]').setValue('correct horse battery')
    await wrapper.get('[data-testid="migrate-form"]').trigger('submit')
    await flushPromises()
    const link = wrapper.get('[data-testid="migrate-signin-instead"]')
    expect(link.attributes('href')).toBe('/login?redirect=%2Fmigrate%2Ftok')
    expect(link.text()).toContain('discordMigration.migrate.signInInstead')
    expect(wrapper.get('[data-testid="migrate-signin-hint"]').text()).toContain('discordMigration.migrate.signInInsteadHint')
  })

  it('other form errors do not offer the sign-in link', async () => {
    h.svc.createAccount.mockRejectedValue(new h.DiscordMigrationError('username_taken'))
    const wrapper = await open({ ticket: 'tkt' })
    await wrapper.get('[data-testid="migrate-username"]').setValue('newbie')
    await wrapper.get('[data-testid="migrate-email"]').setValue('n@example.com')
    await wrapper.get('[data-testid="migrate-password"]').setValue('correct horse battery')
    await wrapper.get('[data-testid="migrate-form"]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="migrate-signin-instead"]').exists()).toBe(false)
  })

  it('a claim refusal shows its message', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockRejectedValue(new h.DiscordMigrationError('kicked_on_harmony'))
    const wrapper = await open({ ticket: 'tkt' })
    expect(wrapper.get('[data-testid="migrate-error"]').text()).toContain('discordMigration.migrate.errors.kicked_on_harmony')
  })

  it('a ticket claimed meanwhile (TICKET_EXPIRED) with an active link shows the result, not an error', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockRejectedValue(new h.DiscordMigrationError('ticket_expired'))
    h.svc.myLink.mockResolvedValue({ status: 'active', syncFields: ['avatar'], discordJoinedAt: null })
    const wrapper = await open({ ticket: 'tkt' })
    expect(h.svc.myLink).toHaveBeenCalledWith('srv')
    expect(wrapper.find('[data-testid="migrate-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="migrate-done"]').exists()).toBe(true)
  })

  it('TICKET_EXPIRED without a link is still an error', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.svc.claim.mockRejectedValue(new h.DiscordMigrationError('ticket_expired'))
    const wrapper = await open({ ticket: 'tkt' })
    expect(wrapper.get('[data-testid="migrate-error"]').text()).toContain('ticket_expired')
  })

  it('prefills the username from the Discord username in the address', async () => {
    const wrapper = await open({ ticket: 'tkt', username: 'dave_d' })
    expect((wrapper.get('[data-testid="migrate-username"]').element as HTMLInputElement).value).toBe('dave_d')
  })

  it('closed reads as the spec copy (locale check)', async () => {
    const en = (await import('@/locales/en.json')).default.discordMigration.migrate.errors
    expect(en.closed).toBe("This migration is closed; ask the server's admins for an invite.")
    expect(en.migration_closed).toBe(en.closed)
  })

  it('Not you? Sign out resets a federated session to the signed-out landing', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'bob', is_local: false }
    h.auth.logout.mockImplementation(async () => {
      h.auth.isLoggedIn = false
      h.profile.profile = null
    })
    const wrapper = await open()
    expect(wrapper.find('[data-testid="migrate-federated"]').exists()).toBe(true)
    await wrapper.get('[data-testid="migrate-federated"] button').trigger('click')
    await flushPromises()
    expect(h.auth.logout).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="migrate-federated"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="migrate-have-account"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="migrate-new-account"]').exists()).toBe(true)
  })

  it('Not you? Sign out on the signed-in landing returns to the two signed-out buttons', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'alice', is_local: true }
    h.auth.logout.mockImplementation(async () => {
      h.auth.isLoggedIn = false
      h.profile.profile = null
    })
    const wrapper = await open()
    await wrapper.get('.mg-link').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="migrate-signin-discord"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="migrate-have-account"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="migrate-new-account"]').exists()).toBe(true)
  })

  it('a failed sign-in after the account was created says so and links to sign in', async () => {
    h.svc.createAccount.mockResolvedValue({ needsConfirmation: false })
    h.auth.login.mockRejectedValue(new Error('boom'))
    const wrapper = await open({ ticket: 'tkt' })
    await wrapper.get('[data-testid="migrate-username"]').setValue('newbie')
    await wrapper.get('[data-testid="migrate-email"]').setValue('n@example.com')
    await wrapper.get('[data-testid="migrate-password"]').setValue('correct horse battery')
    await wrapper.get('[data-testid="migrate-form"]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid="migrate-login-failed"]').text()).toContain('accountCreatedSignIn')
    expect(wrapper.get('[data-testid="migrate-login-link"]').attributes('href')).toBe('/login?redirect=%2Fmigrate%2Ftok')
    expect(h.router.replace).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/new-profile' }))
  })

  it('a federated session is asked to create an account here', async () => {
    h.auth.isLoggedIn = true
    h.profile.profile = { username: 'bob', is_local: false }
    const wrapper = await open({ ticket: 'tkt' })
    expect(h.svc.claim).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="migrate-federated"]').exists()).toBe(true)
  })

  async function fillForm(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="migrate-username"]').setValue('newbie')
    await wrapper.get('[data-testid="migrate-email"]').setValue('n@example.com')
    await wrapper.get('[data-testid="migrate-password"]').setValue('correct horse battery')
    await wrapper.get('[data-testid="migrate-form"]').trigger('submit')
    await flushPromises()
  }

  it('signed out with a ticket shows the new-account form; username_taken is inline', async () => {
    h.svc.createAccount.mockRejectedValue(new h.DiscordMigrationError('username_taken'))
    const wrapper = await open({ ticket: 'tkt' })
    expect(wrapper.find('[data-testid="migrate-form"]').exists()).toBe(true)
    await fillForm(wrapper)
    expect(wrapper.get('[data-testid="migrate-field-error"]').text()).toContain('discordMigration.migrate.errors.username_taken')
    expect(h.auth.login).not.toHaveBeenCalled()
  })

  it('needsConfirmation asks for the email confirmation', async () => {
    h.svc.createAccount.mockResolvedValue({ needsConfirmation: true })
    const wrapper = await open({ ticket: 'tkt' })
    await fillForm(wrapper)
    expect(wrapper.find('[data-testid="migrate-confirm-email"]').exists()).toBe(true)
    expect(h.auth.login).not.toHaveBeenCalled()
  })

  it('without confirmation it signs in and continues to the profile step with the username', async () => {
    h.svc.createAccount.mockResolvedValue({ needsConfirmation: false })
    h.auth.login.mockResolvedValue({})
    const wrapper = await open({ ticket: 'tkt' })
    await fillForm(wrapper)
    expect(h.auth.login).toHaveBeenCalledWith('n@example.com', 'correct horse battery')
    expect(h.router.replace).toHaveBeenCalledWith({ path: '/new-profile', query: { username: 'newbie' } })
  })

  it('account_creation_disabled from the gateway shows the closed-sign-up message', async () => {
    h.svc.createAccount.mockRejectedValue(new h.DiscordMigrationError('account_creation_disabled'))
    const wrapper = await open({ ticket: 'tkt' })
    await fillForm(wrapper)
    expect(wrapper.get('[data-testid="migrate-field-error"]').text()).toContain('discordMigration.migrate.errors.account_creation_disabled')
  })
})
