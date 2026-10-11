import { describe, expect, it, vi } from 'vitest'
import { STALE_RELOAD_KEY, reloadIfStaleBundle, withoutStaleParam } from '../staleBundle'

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}

describe('reloadIfStaleBundle', () => {
  it('reloads once at a fresh URL when the bundle is older than the native shell', async () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const env = { bundleVersion: '1.7.3', nativeVersion: async () => '1.7.4', storage, reload }
    expect(await reloadIfStaleBundle(env)).toBe(true)
    expect(reload).toHaveBeenCalledWith('/?_v=1.7.4')
    expect(storage.getItem(STALE_RELOAD_KEY)).toBe('1.7.4')
    // Still stale after the reload: no loop.
    expect(await reloadIfStaleBundle(env)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the versions match, off the desktop, or without a bundle version', async () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    expect(await reloadIfStaleBundle({ bundleVersion: '1.7.4', nativeVersion: async () => '1.7.4', storage, reload })).toBe(false)
    expect(await reloadIfStaleBundle({ bundleVersion: '1.7.4', nativeVersion: async () => null, storage, reload })).toBe(false)
    expect(await reloadIfStaleBundle({ bundleVersion: 'unknown', nativeVersion: async () => '1.7.4', storage, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload without storage for its loop guard', async () => {
    const reload = vi.fn()
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => {} }
    expect(await reloadIfStaleBundle({ bundleVersion: '1.7.3', nativeVersion: async () => '1.7.4', storage, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('withoutStaleParam', () => {
  it('drops only the cache-busting parameter', () => {
    expect(withoutStaleParam('http://tauri.localhost/?_v=1.7.4')).toBe('/')
    expect(withoutStaleParam('http://tauri.localhost/chat?a=1&_v=1.7.4#x')).toBe('/chat?a=1#x')
    expect(withoutStaleParam('http://tauri.localhost/chat?a=1')).toBeNull()
  })
})
