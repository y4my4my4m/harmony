import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The native app against an instance older than itself: capabilities come from /instance-info,
// a server before 1.9.0 lists none, and the app says once per server version that it is older.

const info = vi.hoisted(() => vi.fn())
vi.mock('vue-toastification', () => ({ useToast: () => ({ info }) }))

const STORED = {
  origin: 'https://chat.example.com', name: 'Example', supabaseUrl: 'https://db.example.com', supabaseAnonKey: 'k', domain: 'example.com',
}

function answer(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    success: true, name: 'Example', domain: 'example.com', supabaseUrl: 'https://db.example.com', supabaseAnonKey: 'k', ...body,
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
}

async function load(stored: Record<string, unknown> | null, native = true) {
  vi.resetModules()
  localStorage.clear()
  if (native) vi.stubGlobal('__TAURI_INTERNALS__', {})
  if (stored) localStorage.setItem('harmony.instance', JSON.stringify(stored))
  return import('@/services/instanceCapabilities')
}

beforeEach(() => info.mockReset())
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('hasCapability', () => {
  it('is true on a web page: the page comes from its instance', async () => {
    const m = await load(null, false)
    expect(m.hasCapability('encrypted-history')).toBe(true)
  })

  it('in the native app, follows what the stored instance lists', async () => {
    expect((await load({ ...STORED, capabilities: ['encrypted-history'] })).hasCapability('encrypted-history')).toBe(true)
    expect((await load({ ...STORED, capabilities: [] })).hasCapability('encrypted-history')).toBe(false)
    expect((await load(STORED)).hasCapability('encrypted-history')).toBe(false)
  })
})

describe('isOlderVersion', () => {
  it('compares major.minor.patch as numbers', async () => {
    const { isOlderVersion } = await load(null, false)
    expect(isOlderVersion('1.8.12', '1.9.0')).toBe(true)
    expect(isOlderVersion('1.8.9', '1.8.12')).toBe(true)
    expect(isOlderVersion('1.9.0', '1.9.0')).toBe(false)
    expect(isOlderVersion('1.10.0', '1.9.3')).toBe(false)
    expect(isOlderVersion('v1.8.0', '1.8.1')).toBe(true)
    expect(isOlderVersion(undefined, '1.9.0')).toBe(false)
    expect(isOlderVersion('dev', '1.9.0')).toBe(false)
  })
})

describe('checkInstanceVersion', () => {
  it('refreshes the stored instance and says once that an older server lacks features', async () => {
    answer({ version: '1.8.12' })
    const m = await load({ ...STORED, version: '1.8.11', capabilities: ['encrypted-history'] })
    await m.checkInstanceVersion('1.9.0')
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain('1.8.12')
    expect(JSON.parse(localStorage.getItem('harmony.instance')!)).toMatchObject({
      origin: STORED.origin, version: '1.8.12', capabilities: [],
    })
    expect(m.hasCapability('encrypted-history')).toBe(false)

    await m.checkInstanceVersion('1.9.0')
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('says nothing to an instance on the app\'s release, and takes its capabilities', async () => {
    answer({ version: '1.9.0', capabilities: ['encrypted-history', 'outgoing-webhooks'] })
    const m = await load({ ...STORED, version: '1.8.12', capabilities: [] })
    await m.checkInstanceVersion('1.9.0')
    expect(info).not.toHaveBeenCalled()
    expect(m.hasCapability('encrypted-history')).toBe(true)
  })

  it('says nothing to an older instance that lacks no capability the app knows', async () => {
    answer({ version: '1.9.0', capabilities: ['encrypted-history', 'outgoing-webhooks', 'channel-create-options'] })
    const m = await load({ ...STORED, version: '1.9.0' })
    await m.checkInstanceVersion('1.9.1')
    expect(info).not.toHaveBeenCalled()
  })

  it('hides outgoing webhooks on an instance that does not list them', async () => {
    answer({ version: '1.9.0', capabilities: ['encrypted-history'] })
    const m = await load({ ...STORED, version: '1.9.0' })
    await m.checkInstanceVersion('1.9.1')
    expect(m.hasCapability('outgoing-webhooks')).toBe(false)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('keeps what it knew when the instance does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const m = await load({ ...STORED, version: '1.9.0', capabilities: ['encrypted-history'] })
    await m.checkInstanceVersion('1.9.0')
    expect(m.hasCapability('encrypted-history')).toBe(true)
    expect(info).not.toHaveBeenCalled()
  })
})
