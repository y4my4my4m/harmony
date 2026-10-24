import { describe, it, expect, vi, afterEach } from 'vitest'
import { nativeInstanceDomain, runtimeConfig, STORED_INSTANCE_KEY } from '@/services/runtimeConfig'
import { fetchInstanceInfo, getInstanceDomain, setStoredInstance } from '@/services/instanceConfig'

// The native client names no instance at build time: its domain is the stored instance's.
// A local author's bare handle resolves against it ("Profile not found" when it was undefined).

const stored = (value: unknown) => ({
  __TAURI_INTERNALS__: {},
  localStorage: { getItem: (key: string) => (key === STORED_INSTANCE_KEY ? JSON.stringify(value) : null) },
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('nativeInstanceDomain', () => {
  it('is the stored /instance-info domain, else the stored origin host', () => {
    expect(nativeInstanceDomain(stored({ origin: 'https://chat.example.com', domain: 'example.com' }))).toBe('example.com')
    expect(nativeInstanceDomain(stored({ origin: 'https://har.mony.lol' }))).toBe('har.mony.lol')
    expect(nativeInstanceDomain(stored({ origin: 'http://localhost:5173' }))).toBe('localhost:5173')
  })

  it('is undefined on a web page, without a stored instance, or with an unreadable one', () => {
    expect(nativeInstanceDomain({ localStorage: stored({ origin: 'https://har.mony.lol' }).localStorage })).toBeUndefined()
    expect(nativeInstanceDomain({ __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null } })).toBeUndefined()
    expect(nativeInstanceDomain({ __TAURI_INTERNALS__: {}, localStorage: { getItem: () => '{not json' } })).toBeUndefined()
    expect(nativeInstanceDomain({ __TAURI_INTERNALS__: {}, localStorage: { getItem: () => { throw new Error('denied') } } })).toBeUndefined()
  })

  it('follows a change of the stored instance', () => {
    let value = JSON.stringify({ origin: 'https://a.example' })
    const scope = { __TAURI__: {}, localStorage: { getItem: () => value } }
    expect(nativeInstanceDomain(scope)).toBe('a.example')
    value = JSON.stringify({ origin: 'https://b.example', domain: 'b.example' })
    expect(nativeInstanceDomain(scope)).toBe('b.example')
  })
})

describe('runtimeConfig.domain in the native client', () => {
  it('is the stored instance domain ahead of the build value', () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    localStorage.setItem(STORED_INSTANCE_KEY, JSON.stringify({
      origin: 'https://har.mony.lol', name: 'Harmony', supabaseUrl: 'https://db.mony.lol', supabaseAnonKey: 'k', domain: 'har.mony.lol',
    }))
    expect(runtimeConfig.domain).toBe('har.mony.lol')
    expect(runtimeConfig.instanceDomain).toBe('har.mony.lol')
    expect(getInstanceDomain()).toBe('har.mony.lol')
  })

  it('is the build value on a web page', () => {
    localStorage.setItem(STORED_INSTANCE_KEY, JSON.stringify({ origin: 'https://elsewhere.example' }))
    expect(runtimeConfig.domain).toBe(import.meta.env.VITE_DOMAIN)
  })
})

describe('fetchInstanceInfo', () => {
  it('keeps the instance domain for the stored instance', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true, name: 'Harmony', domain: 'example.com', version: '1.9.0', supabaseUrl: 'https://db.example.com', supabaseAnonKey: 'k',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const info = await fetchInstanceInfo('chat.example.com')
    expect(info).toMatchObject({ origin: 'https://chat.example.com', domain: 'example.com' })
    setStoredInstance(info)
    expect(runtimeConfig.domain).toBe('example.com')
  })
})
