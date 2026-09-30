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
