import { describe, expect, it, vi } from 'vitest'
import {
  PRELOAD_RELOAD_KEY,
  PRELOAD_RELOAD_WINDOW_MS,
  STALE_RELOAD_KEY,
  claimPreloadReload,
  reloadIfStaleBundle,
  withoutStaleParam,
} from '../staleBundle'

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

describe('claimPreloadReload', () => {
  const A = 'https://chat.test/assets/index-AAAAAAAA.js'
  const B = 'https://chat.test/assets/index-BBBBBBBB.js'
  const T = 1_800_000_000_000

  it('reloads once per bundle within the window, then lets the error through', () => {
    const storage = memoryStorage()
    expect(claimPreloadReload(storage, A, T)).toBe(true)
    expect(JSON.parse(storage.getItem(PRELOAD_RELOAD_KEY) ?? '')).toEqual({ bundle: A, at: T })
    expect(claimPreloadReload(storage, A, T + 1000)).toBe(false)
    expect(claimPreloadReload(storage, A, T + PRELOAD_RELOAD_WINDOW_MS - 1)).toBe(false)
  })

  it('reloads after an earlier reload of the tab: another bundle, an older one, or the old flag', () => {
    const storage = memoryStorage()
    expect(claimPreloadReload(storage, A, T)).toBe(true)
    expect(claimPreloadReload(storage, B, T + 1000)).toBe(true)
    expect(claimPreloadReload(storage, B, T + 1000 + PRELOAD_RELOAD_WINDOW_MS)).toBe(true)
    storage.setItem(PRELOAD_RELOAD_KEY, '1')
    expect(claimPreloadReload(storage, B, T)).toBe(true)
    storage.setItem(PRELOAD_RELOAD_KEY, '{not json')
    expect(claimPreloadReload(storage, B, T + 1)).toBe(true)
  })

  it('never reloads without storage, or when writing the record fails', () => {
    expect(claimPreloadReload(null, A, T)).toBe(false)
    const throwing = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(claimPreloadReload(throwing, A, T)).toBe(false)
  })
})
