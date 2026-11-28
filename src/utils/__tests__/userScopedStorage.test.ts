import { describe, it, expect, beforeEach, vi } from 'vitest'

// User-scoped values belong to the signed-in user. With nobody signed in there is no such user:
// nothing is written, and nothing is read from a name every account on the device shares.

async function freshStorage() {
  vi.resetModules()
  const { userStorage } = await import('@/utils/userScopedStorage')
  return userStorage
}

/** The instance-global name an older client wrote `key` under with nobody signed in. */
async function globalNameOf(key: string): Promise<string> {
  const storage = await freshStorage()
  storage.setCurrentUser('probe')
  storage.setItem(key, 'x')
  const userKey = Object.keys(localStorage).find((k) => k.endsWith(`user_probe_${key}`))!
  localStorage.clear()
  return userKey.replace('user_probe_', '')
}

beforeEach(() => {
  localStorage.clear()
})

describe('user-scoped storage', () => {
  it('writes nothing with nobody signed in', async () => {
    const storage = await freshStorage()

    storage.setItem('message-drafts', '{"channel:1":"left by the last account"}')

    expect(Object.keys(localStorage).filter((k) => k.includes('message-drafts'))).toEqual([])
    expect(storage.getItem('message-drafts')).toBeNull()
  })

  it('reads nothing from the instance-global name, signed out or signed in', async () => {
    const shared = await globalNameOf('app-state')
    localStorage.setItem(shared, '{"lastServerId":"srv-of-account-a"}')
    const storage = await freshStorage()

    expect(storage.getItem('app-state')).toBeNull()
    expect(storage.hasItem('app-state')).toBe(false)

    storage.setCurrentUser('account-b')
    expect(storage.getItem('app-state')).toBeNull()
  })

  it('removes values an older client left under the instance-global name', async () => {
    const shared = await globalNameOf('app-state')
    localStorage.setItem(shared, '{"lastServerId":"srv-of-account-a"}')
    localStorage.setItem('harmony-keybinds', '{}')

    await freshStorage()

    expect(localStorage.getItem(shared)).toBeNull()
    expect(localStorage.getItem('harmony-keybinds')).toBe('{}')
  })

  it("keeps each signed-in account's values apart", async () => {
    const storage = await freshStorage()
    storage.setCurrentUser('account-a')
    storage.setItem('message-drafts', 'a')
    expect(storage.getItem('message-drafts')).toBe('a')

    storage.setCurrentUser('account-b')
    expect(storage.getItem('message-drafts')).toBeNull()
    storage.setItem('message-drafts', 'b')
    expect(storage.getItem('message-drafts')).toBe('b')
  })

  it('a removal with nobody signed in touches no account', async () => {
    const storage = await freshStorage()
    storage.setCurrentUser('account-a')
    storage.setItem('voiceChannelState', 'a')
    const stored = Object.keys(localStorage).filter((k) => k.includes('voiceChannelState'))

    storage.clearCurrentUser()
    localStorage.setItem(stored[0], 'kept')
    storage.removeItem('voiceChannelState')

    expect(localStorage.getItem(stored[0])).toBe('kept')
  })
})
