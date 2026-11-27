/**
 * Rules before joining a server hosted elsewhere: the home instance's rules, then the server's,
 * from the invite or, for a server found by handle or URL, from its Group (harmony:welcome,
 * harmony:instanceRules). Not shown to a member, nor for a server that refuses remote members.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const { discoverServer, joinServer, servers, t } = vi.hoisted(() => ({
  discoverServer: vi.fn(),
  joinServer: vi.fn(),
  servers: [] as Array<{ id: string }>,
  t: (key: string) => key,
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
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => vi.fn() }))
vi.mock('@/services/userDataService', () => ({ userDataService: { resolveDisplayNameParts: vi.fn() } }))

import JoinFederatedServer from '../JoinFederatedServer.vue'

enableAutoUnmount(afterEach)

const UUID = 'eaa74f77-149a-4a43-9a0e-2a51a2a0078f'
const SERVER = {
  id: `https://chat.example/servers/${UUID}`,
  name: 'Hall',
  description: '',
  memberCount: 1,
  channels: [],
  inbox: `https://chat.example/servers/${UUID}/inbox`,
  discoverable: true,
  instance: 'chat.example',
  federationEnabled: true,
}

async function open(result: Record<string, unknown>, initialUrl = SERVER.id) {
  discoverServer.mockResolvedValue({ success: true, ...result })
  const wrapper = mount(JoinFederatedServer, {
    props: { initialUrl },
    global: { stubs: { Icon: true, DisplayName: true }, mocks: { $t: t } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const listed = (wrapper: Awaited<ReturnType<typeof open>>) =>
  wrapper.findAll('[data-testid="join-federated-rules"] li').map((li) => li.text())

beforeEach(() => {
  discoverServer.mockReset()
  joinServer.mockReset()
  servers.length = 0
})

describe('JoinFederatedServer rules', () => {
  it('lists the rules of a server found by handle, home instance rules first', async () => {
    const wrapper = await open({
      isInvite: false,
      server: { ...SERVER, serverRules: ['Be kind'], instanceRules: ['Follow the law'] },
    }, 'hall@chat.example')
    expect(listed(wrapper)).toEqual(['Follow the law', 'Be kind'])
    expect(wrapper.get('[data-testid="join-federated-rules"]').text()).toContain('federation.rulesAgreeNote')
  })

  it("lists an invite's rules", async () => {
    const wrapper = await open({
      isInvite: true,
      server: SERVER,
      invite: { code: 'HALL', server: SERVER, serverRules: ['No spam'], instanceRules: [] },
    }, 'https://chat.example/invite/HALL')
    expect(listed(wrapper)).toEqual(['No spam'])
  })

  it('shows no list for a server with no rules, one that refuses remote members, or to a member', async () => {
    expect((await open({ isInvite: false, server: { ...SERVER, serverRules: [], instanceRules: [] } }))
      .find('[data-testid="join-federated-rules"]').exists()).toBe(false)

    expect((await open({ isInvite: false, server: { ...SERVER, federationEnabled: false, serverRules: ['Be kind'] } }))
      .find('[data-testid="join-federated-rules"]').exists()).toBe(false)

    servers.push({ id: UUID })
    expect((await open({ isInvite: false, server: { ...SERVER, serverRules: ['Be kind'] } }))
      .find('[data-testid="join-federated-rules"]').exists()).toBe(false)
  })
})
