import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('StatePersistence last server/channel', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function freshService() {
    const { userStorage } = await import('@/utils/userScopedStorage')
    userStorage.setCurrentUser('user-a')
    const { statePersistence } = await import('@/services/StatePersistence')
    await statePersistence.initialize()
    return { statePersistence, userStorage }
  }

  it('writes the last server and channel to storage', async () => {
    const { statePersistence, userStorage } = await freshService()

    await statePersistence.setLastServer('srv-1')
    await statePersistence.setLastChannel('srv-1', 'ch-9')
    await vi.runAllTimersAsync()

    const stored = JSON.parse(userStorage.getItem('app-state') ?? '{}')
    expect(stored.lastServerId).toBe('srv-1')
    expect(stored.lastChannelByServer).toEqual({ 'srv-1': 'ch-9' })
  })

  it('flushes a pending write when the page is hidden', async () => {
    const { statePersistence, userStorage } = await freshService()

    await statePersistence.setLastServer('srv-2')
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()

    const stored = JSON.parse(userStorage.getItem('app-state') ?? '{}')
    expect(stored.lastServerId).toBe('srv-2')
  })

  it('does not carry channels across a state reset', async () => {
    const { statePersistence } = await freshService()

    await statePersistence.setLastChannel('srv-1', 'ch-9')
    await statePersistence.clearState()

    expect(statePersistence.getLastChannel('srv-1')).toBeNull()
  })
})

describe('StatePersistence per account', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('the next account to sign in on the tab reads its own state, not the last one\'s', async () => {
    const { userStorage } = await import('@/utils/userScopedStorage')
    const { statePersistence } = await import('@/services/StatePersistence')
    userStorage.setCurrentUser('user-a')
    await statePersistence.initialize()
    await statePersistence.setLastServer('srv-a')
    await statePersistence.setLastChannel('srv-a', 'ch-a')
    await statePersistence.setCategoryCollapseState('srv-a', 'cat-a', true)

    // Sign-out, then another account on the same tab.
    await statePersistence.cleanup()
    userStorage.clearCurrentUser()
    userStorage.setCurrentUser('user-b')
    await statePersistence.initialize()

    expect(statePersistence.getLastServer()).toBeNull()
    expect(statePersistence.getLastChannel('srv-a')).toBeNull()
    expect(statePersistence.getServerCategoryStates('srv-a')).toEqual({})
  })

  it('reads the account\'s state when it signs in after a signed-out start', async () => {
    const seed = await import('@/utils/userScopedStorage')
    seed.userStorage.setCurrentUser('user-b')
    seed.userStorage.setItem('app-state', JSON.stringify({ lastServerId: 'srv-b', lastChannelByServer: { 'srv-b': 'ch-b' } }))
    localStorage.removeItem('harmony_current_user_id')
    vi.resetModules()

    const { userStorage } = await import('@/utils/userScopedStorage')
    const { statePersistence } = await import('@/services/StatePersistence')
    expect(userStorage.getCurrentUser()).toBeNull()
    await statePersistence.initialize()

    userStorage.setCurrentUser('user-b')
    await statePersistence.initialize()

    expect(statePersistence.getLastServer()).toBe('srv-b')
    expect(statePersistence.getLastChannel('srv-b')).toBe('ch-b')
  })

  it('a change still pending at sign-out is written under no name', async () => {
    const { userStorage } = await import('@/utils/userScopedStorage')
    const { statePersistence } = await import('@/services/StatePersistence')
    userStorage.setCurrentUser('user-a')
    await statePersistence.initialize()
    await statePersistence.setCategoryCollapseState('srv-a', 'cat-a', true)

    userStorage.clearCurrentUser()
    await vi.runAllTimersAsync()
    await statePersistence.cleanup()

    expect(Object.keys(localStorage).filter((k) => k.includes('app-state'))).toEqual([])
  })
})
