/**
 * A remote server that refuses members from other instances: the dialog says so before a Join
 * (discovery's federationEnabled false) and, when the Join is answered with a Reject, names the
 * server and the Reject's reason instead of opening a server the user never joined. A server
 * this instance blocked, or keeps the account out of, is refused here and said so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const { discoverServer, joinServer, openServer, servers, t } = vi.hoisted(() => ({
  discoverServer: vi.fn(),
  joinServer: vi.fn(),
  openServer: vi.fn(),
  servers: [] as Array<{ id: string; federation_inbox_url?: string }>,
  // A key and its parameters, so a test reads which message and which values were shown.
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}` : key,
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/services/federation', () => ({
  federationServerService: { discoverServer, joinServer },
  remoteServerUuid: (id: string) => id.split('/servers/')[1] ?? null,
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ servers, fetchServersForUser: vi.fn() }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { allowCustomEmojisInDisplayNames: false } }),
}))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => openServer }))
vi.mock('@/services/userDataService', () => ({ userDataService: { resolveDisplayNameParts: vi.fn() } }))

import JoinFederatedServer from '../JoinFederatedServer.vue'

enableAutoUnmount(afterEach)

const SERVER = {
  id: 'https://chat.example/servers/eaa74f77-149a-4a43-9a0e-2a51a2a0078f',
  name: 'Mastodon Canada',
  description: '',
  memberCount: 1,
  channels: [],
  inbox: 'https://chat.example/servers/eaa74f77-149a-4a43-9a0e-2a51a2a0078f/inbox',
  discoverable: true,
  instance: 'chat.example',
}

async function discovered(federationEnabled: boolean | null) {
  discoverServer.mockResolvedValue({ success: true, server: { ...SERVER, federationEnabled } })
  const wrapper = mount(JoinFederatedServer, {
    props: { initialUrl: SERVER.id },
    global: { stubs: { Icon: true, DisplayName: true }, mocks: { $t: t } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  discoverServer.mockReset()
  joinServer.mockReset()
  openServer.mockReset()
  servers.length = 0
})

describe('JoinFederatedServer and a server that refuses remote members', () => {
  it('disables Join and says why when the server has federation off', async () => {
    const wrapper = await discovered(false)
    const join = wrapper.get('[data-testid="join-federated-submit"]')
    expect(join.attributes('disabled')).toBeDefined()
    expect(join.attributes('aria-describedby')).toBe('join-federated-closed')
    expect(wrapper.get('[data-testid="join-federated-closed"]').text()).toContain('federation.federationOff')
  })

  it('says the server has federation off to a member too, who can still open it', async () => {
    servers.push({ id: 'eaa74f77-149a-4a43-9a0e-2a51a2a0078f' })
    const wrapper = await discovered(false)
    expect(wrapper.get('[data-testid="join-federated-closed"]').text()).toContain('federation.federationOff')
    expect(wrapper.find('[data-testid="join-federated-submit"]').exists()).toBe(false)
    const open = wrapper.findAll('button').find((b) => b.text() === 'federation.openServer')!
    expect(open.attributes('disabled')).toBeUndefined()
    await open.trigger('click')
    await flushPromises()
    expect(openServer).toHaveBeenCalledWith('eaa74f77-149a-4a43-9a0e-2a51a2a0078f')
  })

  it("says so when the server's invite is refused to other instances", async () => {
    discoverServer.mockResolvedValue({ success: false, federationDisabled: true, error: 'This server does not accept members from other instances' })
    const wrapper = mount(JoinFederatedServer, {
      props: { initialUrl: 'https://chat.example/invite/HALL' },
      global: { stubs: { Icon: true, DisplayName: true }, mocks: { $t: t } },
      attachTo: document.body,
    })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('federation.federationOff')
    expect(wrapper.get('[data-testid="join-federated-submit"]').attributes('disabled')).toBeDefined()
  })

  it.each([true, null])('offers Join when federationEnabled is %s', async (flag) => {
    const wrapper = await discovered(flag)
    expect(wrapper.get('[data-testid="join-federated-submit"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="join-federated-closed"]').exists()).toBe(false)
  })

  it("names the server and the Reject's reason, and opens nothing", async () => {
    const wrapper = await discovered(null)
    joinServer.mockResolvedValue({
      success: false, rejected: true, reason: 'Federation is disabled on this server',
      error: 'Federation is disabled on this server',
    })
    await wrapper.get('[data-testid="join-federated-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text())
      .toContain('federation.joinRefusedReason name=Mastodon Canada reason=Federation is disabled on this server')
    expect(openServer).not.toHaveBeenCalled()
    expect(wrapper.emitted('joined')).toBeUndefined()
  })

  it('says this instance blocked the server when discovery is refused here', async () => {
    discoverServer.mockResolvedValue({ success: false, refusedHere: 'server_blocked_here', error: 'blocked' })
    const wrapper = mount(JoinFederatedServer, {
      props: { initialUrl: SERVER.id },
      global: { stubs: { Icon: true, DisplayName: true }, mocks: { $t: t } },
      attachTo: document.body,
    })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('instanceServer.join.blocked instance=harmony.test')
  })

  it('says this instance keeps the account out when the join is refused here, and opens nothing', async () => {
    const wrapper = await discovered(null)
    joinServer.mockResolvedValue({ success: false, refusedHere: 'kept_out_here', error: 'kept out' })
    await wrapper.get('[data-testid="join-federated-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('instanceServer.join.keptOut instance=harmony.test')
    expect(openServer).not.toHaveBeenCalled()
  })

  it('names the server when the Reject gives no reason', async () => {
    const wrapper = await discovered(null)
    joinServer.mockResolvedValue({ success: false, rejected: true, reason: null, error: 'The server refused the join' })
    await wrapper.get('[data-testid="join-federated-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('federation.joinRefused name=Mastodon Canada')
  })
})
