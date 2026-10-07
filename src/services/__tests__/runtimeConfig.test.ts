import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RUNTIME_CONFIG_KEYS,
  fetchRuntimeConfig,
  parseRuntimeConfig,
  runtimeConfig,
  setRuntimeConfig,
  shouldFetchRuntimeConfig,
} from '@/services/runtimeConfig'
import { getInstanceDomain } from '@/services/instanceConfig'
import { getMessageShareUrl } from '@/utils/messageShareUrl'
import { debug } from '@/utils/debug'

// Build env from vitest.config.ts `define`.
const BUILD_DOMAIN = 'harmony.test'
const BUILD_SUPABASE_URL = 'http://localhost:54321'
const BUILD_ANON_KEY = 'test-anon-key'

function response(body: string, init: { status?: number; type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.type === undefined ? { 'content-type': 'application/json' } : { 'content-type': init.type },
  })
}

function fetchReturning(res: Response | Promise<Response>) {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(res))
}

afterEach(() => {
  setRuntimeConfig({})
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('parseRuntimeConfig', () => {
  it('keeps known keys with non-empty strings, trimmed', () => {
    expect(
      parseRuntimeConfig({
        supabaseUrl: ' https://db.example.org ',
        supabaseAnonKey: 'anon',
        domain: 'example.org',
      })
    ).toEqual({ supabaseUrl: 'https://db.example.org', supabaseAnonKey: 'anon', domain: 'example.org' })
  })

  it('drops unknown keys, non-strings and empty strings', () => {
    expect(
      parseRuntimeConfig({
        domain: '',
        instanceName: '   ',
        appUrl: 42,
        termsUrl: null,
        privacyUrl: { url: 'x' },
        serviceRoleKey: 'never-read',
      })
    ).toEqual({})
  })

  it('is null for anything but a JSON object', () => {
    for (const raw of [null, undefined, 'domain', 7, true, ['domain']]) {
      expect(parseRuntimeConfig(raw)).toBeNull()
    }
  })
})

describe('fetchRuntimeConfig', () => {
  it('returns the served values', async () => {
    const fetchImpl = fetchReturning(
      response(JSON.stringify({ supabaseUrl: 'https://db.example.org', supabaseAnonKey: 'anon', domain: 'example.org' }))
    )
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toEqual({
      supabaseUrl: 'https://db.example.org',
      supabaseAnonKey: 'anon',
      domain: 'example.org',
    })
  })

  it('requests a cache-busted URL past the HTTP cache', async () => {
    const fetchImpl = fetchReturning(response('{}'))
    await fetchRuntimeConfig(fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toMatch(/^\/config\.json\?t=\d+$/)
    expect(init?.cache).toBe('no-store')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('treats a 404 as absent', async () => {
    const error = vi.spyOn(debug, 'error').mockImplementation(() => {})
    await expect(fetchRuntimeConfig(fetchReturning(response('not found', { status: 404, type: 'text/html' })))).resolves.toEqual({})
    expect(error).not.toHaveBeenCalled()
  })

  it('treats a SPA fallback (index.html) as absent', async () => {
    const error = vi.spyOn(debug, 'error').mockImplementation(() => {})
    const html = '<!DOCTYPE html><html><body><div id="app"></div></body></html>'
    await expect(fetchRuntimeConfig(fetchReturning(response(html, { type: 'text/html; charset=utf-8' })))).resolves.toEqual({})
    expect(error).not.toHaveBeenCalled()
  })

  it('reports malformed JSON and falls back', async () => {
    const error = vi.spyOn(debug, 'error').mockImplementation(() => {})
    await expect(fetchRuntimeConfig(fetchReturning(response('{"domain": "example.org",')))).resolves.toEqual({})
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))
  })

  it('reports a JSON document that is not an object and falls back', async () => {
    const error = vi.spyOn(debug, 'error').mockImplementation(() => {})
    await expect(fetchRuntimeConfig(fetchReturning(response('["example.org"]')))).resolves.toEqual({})
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'))
  })

  it('reports a network failure and falls back', async () => {
    const error = vi.spyOn(debug, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toEqual({})
    expect(error).toHaveBeenCalled()
  })

  it('gives up after the timeout', async () => {
    vi.spyOn(debug, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    await expect(fetchRuntimeConfig(fetchImpl, 5)).resolves.toEqual({})
  })
})

describe('shouldFetchRuntimeConfig', () => {
  const browser = { window: {} }

  it('fetches on a web page', () => {
    expect(shouldFetchRuntimeConfig('production', browser)).toBe(true)
    expect(shouldFetchRuntimeConfig('development', browser)).toBe(true)
  })

  it('skips under unit tests', () => {
    expect(shouldFetchRuntimeConfig('test', browser)).toBe(false)
    expect(shouldFetchRuntimeConfig()).toBe(false)
  })

  it('skips without a window', () => {
    expect(shouldFetchRuntimeConfig('production', {})).toBe(false)
  })

  it('skips in the native client', () => {
    expect(shouldFetchRuntimeConfig('production', { ...browser, __TAURI_INTERNALS__: {} })).toBe(false)
    expect(shouldFetchRuntimeConfig('production', { ...browser, __TAURI__: {} })).toBe(false)
  })
})

describe('runtimeConfig', () => {
  it('falls back to the build env without /config.json', () => {
    expect(runtimeConfig.domain).toBe(BUILD_DOMAIN)
    expect(runtimeConfig.supabaseUrl).toBe(BUILD_SUPABASE_URL)
    expect(runtimeConfig.supabaseAnonKey).toBe(BUILD_ANON_KEY)
  })

  it('prefers served values per key', () => {
    setRuntimeConfig({ domain: 'example.org' })
    expect(runtimeConfig.domain).toBe('example.org')
    expect(runtimeConfig.supabaseUrl).toBe(BUILD_SUPABASE_URL)
  })

  it('keeps the build value for an empty served value', () => {
    setRuntimeConfig({ domain: '' })
    expect(runtimeConfig.domain).toBe(BUILD_DOMAIN)
  })

  it('maps every key to its own getter', () => {
    const served = Object.fromEntries(RUNTIME_CONFIG_KEYS.map((key) => [key, `served-${key}`]))
    setRuntimeConfig(served)
    for (const key of RUNTIME_CONFIG_KEYS) {
      expect(runtimeConfig[key]).toBe(`served-${key}`)
    }
    expect(Object.keys(runtimeConfig).sort()).toEqual([...RUNTIME_CONFIG_KEYS].sort())
  })

  it('restores the build env on reset', () => {
    setRuntimeConfig({ domain: 'example.org' })
    setRuntimeConfig({})
    expect(runtimeConfig.domain).toBe(BUILD_DOMAIN)
  })

  it('copies the applied config', () => {
    const config = { domain: 'example.org' }
    setRuntimeConfig(config)
    config.domain = 'mutated.example'
    expect(runtimeConfig.domain).toBe('example.org')
  })
})

describe('module load', () => {
  it('does not fetch under unit tests', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.resetModules()
    const mod = await import('@/services/runtimeConfig')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mod.runtimeConfig.domain).toBe(BUILD_DOMAIN)
  })

  it('applies /config.json before importers evaluate', async () => {
    vi.stubEnv('MODE', 'production')
    const fetchSpy = fetchReturning(response(JSON.stringify({ domain: 'served.example', instanceName: 'Served' })))
    vi.stubGlobal('fetch', fetchSpy)
    vi.resetModules()
    const mod = await import('@/services/runtimeConfig')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mod.runtimeConfig.domain).toBe('served.example')
    expect(mod.runtimeConfig.instanceName).toBe('Served')
    expect(mod.runtimeConfig.supabaseUrl).toBe(BUILD_SUPABASE_URL)
  })

  it('holds module-scope reads of importers until /config.json resolves', async () => {
    vi.stubEnv('MODE', 'production')
    let release: (res: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', fetchReturning(pending))
    vi.resetModules()
    const importer = import('@/config/activitypub')
    setTimeout(() => release(response(JSON.stringify({ domain: 'late.example' }))), 10)
    const { ACTIVITYPUB_CONFIG } = await importer
    expect(ACTIVITYPUB_CONFIG.domain).toBe('late.example')
    expect(ACTIVITYPUB_CONFIG.baseUrl).toBe('https://late.example')
  })

  it('keeps the build env when /config.json is absent', async () => {
    vi.stubEnv('MODE', 'production')
    vi.stubGlobal('fetch', fetchReturning(response('<!DOCTYPE html>', { type: 'text/html' })))
    vi.resetModules()
    const mod = await import('@/services/runtimeConfig')
    expect(mod.runtimeConfig.domain).toBe(BUILD_DOMAIN)
    expect(mod.runtimeConfig.supabaseUrl).toBe(BUILD_SUPABASE_URL)
  })
})

describe('consumers', () => {
  it('getInstanceDomain reads the served domain on web', () => {
    expect(getInstanceDomain()).toBe(BUILD_DOMAIN)
    setRuntimeConfig({ domain: 'example.org' })
    expect(getInstanceDomain()).toBe('example.org')
  })

  it('getMessageShareUrl builds links on the served domain', () => {
    setRuntimeConfig({ domain: 'example.org' })
    expect(getMessageShareUrl({ messageId: 'm1', conversationId: 'c1' })).toBe('https://example.org/dm/c1?messageId=m1')
  })
})
