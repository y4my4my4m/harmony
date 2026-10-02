import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { ServerWelcome } from '@/services/ServerWelcomeService'

const api = vi.hoisted(() => ({
  getServerWelcome: vi.fn(),
  markServerWelcomeSeen: vi.fn(),
  acceptServerRules: vi.fn(),
}))

vi.mock('@/services/ServerWelcomeService', () => api)

import { useServerWelcomeStore } from '@/stores/useServerWelcome'

function welcome(overrides: Partial<ServerWelcome> = {}): ServerWelcome {
  return {
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
    can_manage: false,
    is_member: true,
    joined_at: '2026-10-01T00:00:00Z',
    welcome_seen_at: null,
    rules_accepted_at: null,
    must_accept: false,
    should_show: true,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  api.getServerWelcome.mockReset()
  api.markServerWelcomeSeen.mockReset()
  api.acceptServerRules.mockReset()
})

describe('useServerWelcomeStore', () => {
  it('opens the screen on a visit the server says to show, once per session', async () => {
    api.getServerWelcome.mockResolvedValue(welcome())
    const store = useServerWelcomeStore()

    await store.visit('s1')
    expect(store.openServerId).toBe('s1')
    expect(store.current?.name).toBe('Town Hall')

    store.openServerId = null
    await store.visit('s1')
    expect(api.getServerWelcome).toHaveBeenCalledTimes(1)
  })

  it('stays closed when the member has seen the screen', async () => {
    api.getServerWelcome.mockResolvedValue(welcome({ should_show: false, welcome_seen_at: '2026-10-01T00:00:00Z' }))
    const store = useServerWelcomeStore()
    await store.visit('s1')
    expect(store.openServerId).toBeNull()
  })

  it('shares one request between concurrent loads and remembers a failure', async () => {
    let resolve!: (w: ServerWelcome) => void
    api.getServerWelcome.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const store = useServerWelcomeStore()
    const a = store.load('s1')
    const b = store.load('s1')
    resolve(welcome())
    expect(await a).toEqual(await b)
    expect(api.getServerWelcome).toHaveBeenCalledTimes(1)

    api.getServerWelcome.mockRejectedValueOnce(new Error('function does not exist'))
    expect(await store.load('s2')).toBeNull()
    expect(await store.load('s2')).toBeNull()
    expect(api.getServerWelcome).toHaveBeenCalledTimes(2)
  })

  it('records the screen as seen when it is first closed', async () => {
    api.getServerWelcome.mockResolvedValue(welcome())
    api.markServerWelcomeSeen.mockResolvedValue(welcome({ should_show: false, welcome_seen_at: 'now' }))
    const store = useServerWelcomeStore()
    await store.visit('s1')
    await store.dismiss()

    expect(store.openServerId).toBeNull()
    expect(api.markServerWelcomeSeen).toHaveBeenCalledWith('s1')
    expect(store.byServer.s1.welcome_seen_at).toBe('now')

    api.getServerWelcome.mockResolvedValue(welcome({ should_show: false, welcome_seen_at: 'now' }))
    await store.open('s1')
    await store.dismiss()
    expect(api.markServerWelcomeSeen).toHaveBeenCalledTimes(1)
  })

  it('accepts the rules and clears the composer prompt', async () => {
    api.getServerWelcome.mockResolvedValue(welcome({ require_acceptance: true, must_accept: true }))
    api.acceptServerRules.mockResolvedValue(
      welcome({ require_acceptance: true, must_accept: false, rules_accepted_at: 'now', welcome_seen_at: 'now' }),
    )
    const store = useServerWelcomeStore()
    await store.visit('s1')
    expect(store.mustAccept('s1')).toBe(true)

    expect(await store.accept()).toBe(true)
    expect(store.mustAccept('s1')).toBe(false)
    expect(store.openServerId).toBeNull()
  })

  it('keeps the screen open with the error when accepting fails', async () => {
    api.getServerWelcome.mockResolvedValue(welcome({ require_acceptance: true, must_accept: true }))
    api.acceptServerRules.mockRejectedValue(new Error('Not a member of this server'))
    const store = useServerWelcomeStore()
    await store.open('s1')

    expect(await store.accept()).toBe(false)
    expect(store.openServerId).toBe('s1')
    expect(store.error).toBe('Not a member of this server')
  })

  it('reloads a stale state after a RULES_NOT_ACCEPTED rejection', async () => {
    api.getServerWelcome
      .mockResolvedValueOnce(welcome({ should_show: false }))
      .mockResolvedValueOnce(welcome({ require_acceptance: true, must_accept: true, should_show: false }))
    const store = useServerWelcomeStore()
    await store.visit('s1')
    expect(store.mustAccept('s1')).toBe(false)

    await store.handleRulesRejection('s1')
    expect(api.getServerWelcome).toHaveBeenCalledTimes(2)
    expect(store.mustAccept('s1')).toBe(true)
  })

  it('offers the dropdown entry only for an enabled screen or rules', async () => {
    api.getServerWelcome
      .mockResolvedValueOnce(welcome({ enabled: false, rules: [] }))
      .mockResolvedValueOnce(welcome({ enabled: false }))
    const store = useServerWelcomeStore()
    await store.load('s1')
    await store.load('s2')
    expect(store.hasScreen('s1')).toBe(false)
    expect(store.hasScreen('s2')).toBe(true)
    expect(store.hasScreen('unknown')).toBe(false)
  })

  it('forgets everything on reset', async () => {
    api.getServerWelcome.mockResolvedValue(welcome())
    const store = useServerWelcomeStore()
    await store.visit('s1')
    store.reset()
    expect(store.byServer).toEqual({})
    expect(store.openServerId).toBeNull()
  })
})
