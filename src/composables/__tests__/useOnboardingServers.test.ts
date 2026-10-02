import { describe, it, expect, beforeEach, vi } from 'vitest'

const m = vi.hoisted(() => ({
  getOnboardingServers: vi.fn(),
  joinServer: vi.fn(),
  fetchServersForUser: vi.fn(),
  openServer: vi.fn(),
}))

vi.mock('@/services/ServerWelcomeService', () => ({ getOnboardingServers: m.getOnboardingServers }))
vi.mock('@/stores/server', () => ({ useServerStore: () => ({ joinServer: m.joinServer }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ fetchServersForUser: m.fetchServersForUser }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => m.openServer }))

import { useOnboardingServers } from '@/composables/useOnboardingServers'

const HALL = { id: 'hall', name: 'Town Hall', description: null, icon: null, banner: null, member_count: 83 }
const FEAT = { id: 'feat', name: 'Featured', description: null, icon: null, banner: null, member_count: 4 }

beforeEach(() => {
  localStorage.clear()
  Object.values(m).forEach((fn) => fn.mockReset())
  m.fetchServersForUser.mockResolvedValue(undefined)
  m.openServer.mockResolvedValue(undefined)
})

describe('useOnboardingServers', () => {
  it('loads the suggestions', async () => {
    m.getOnboardingServers.mockResolvedValue({ source: 'welcome', servers: [HALL] })
    const o = useOnboardingServers()
    await o.load()
    expect(o.loaded.value).toBe(true)
    expect(o.servers.value).toEqual([HALL])
  })

  it('suggests nothing when the read fails', async () => {
    m.getOnboardingServers.mockRejectedValue(new Error('offline'))
    const o = useOnboardingServers()
    const result = await o.load()
    expect(result).toEqual({ source: 'none', servers: [] })
    expect(o.servers.value).toEqual([])
  })

  it('joins through join_public_server, refreshes the server list and opens the server', async () => {
    m.joinServer.mockResolvedValue(true)
    const o = useOnboardingServers()
    expect(await o.join('hall')).toBe(true)
    expect(m.joinServer).toHaveBeenCalledWith('hall')
    expect(m.fetchServersForUser).toHaveBeenCalledWith('me', true)
    expect(m.openServer).toHaveBeenCalledWith('hall')
    expect(o.joiningId.value).toBeNull()
  })

  it('stays put when the join is refused', async () => {
    m.joinServer.mockResolvedValue(false)
    const o = useOnboardingServers()
    expect(await o.join('hall')).toBe(false)
    expect(m.openServer).not.toHaveBeenCalled()
  })

  it('remembers a dismissal on this device when asked to', async () => {
    m.getOnboardingServers.mockResolvedValue({ source: 'featured', servers: [HALL, FEAT] })
    const splash = useOnboardingServers({ respectDismissed: true })
    await splash.load()
    splash.dismiss()
    expect(splash.servers.value).toEqual([])

    const again = useOnboardingServers({ respectDismissed: true })
    await again.load()
    expect(again.servers.value).toEqual([])

    const signup = useOnboardingServers()
    await signup.load()
    expect(signup.servers.value).toEqual([HALL, FEAT])
  })
})
