import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Other instances' server directories (routes/directory.ts, services/RemoteDirectoryService.ts):
// found through NodeInfo metadata.serverDirectory, read signed, kept to listed Groups on the
// domain asked for, never read from a blocked instance or while federation is off, cached.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({ discoveryLimiter: (_req: any, _res: any, next: any) => next() }))
vi.mock('../middleware/auth.js', () => ({
  localProfileIdFromBearer: async (header: string | undefined) => (header === 'Bearer member' ? 'profile-1' : null),
}))
vi.mock('../utils/urlUtils.js', () => ({ getFullServerIconUrl: () => null }))

const switches = vi.hoisted(() => ({ inbound: true, outbound: true }))
vi.mock('../services/FederationSwitches.js', () => ({ federationSwitches: async () => switches }))

const blockedHosts = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => blockedHosts.has(host) },
}))

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../utils/cache.js', () => ({
  cache: {
    getAsync: async (key: string) => store.get(key),
    set: (key: string, value: unknown) => { store.set(key, value); return true },
  },
}))

const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: (...args: any[]) => safeFetch(...args),
  validateExternalHostname: (host: string) => {
    if (host.startsWith('10.')) throw new Error('Blocked private IP')
  },
}))
const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: { signedApFetch } }))

// Tables answered to the service client, filtered by `.in()` and `.eq()` as PostgREST would.
const tables = vi.hoisted(() => ({} as Record<string, any[]>))
const rpc = vi.hoisted(() => vi.fn(async (_name: string, _args: any) => ({ data: true, error: null })))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc,
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])]
      const q: any = {
        select: () => q,
        in: (col: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[col])); return q },
        eq: (col: string, value: unknown) => { rows = rows.filter((r) => r[col] === value); return q },
        not: (col: string, op: string, value: unknown) => {
          if (col === 'metadata->>server_directory') rows = rows.filter((r) => r.metadata?.server_directory != null)
          else if (op === 'is') rows = rows.filter((r) => r[col] !== value)
          return q
        },
        or: () => { rows = rows.filter((r) => r.software === 'harmony' || r.metadata?.server_directory != null); return q },
        gte: () => q,
        order: () => q,
        limit: () => q,
        then: (resolve: any) => resolve({ data: rows, error: null }),
      }
      return q
    },
  }),
}))

const { default: router } = await import('../routes/directory.js')
const { directoryEntry, normalizeDirectoryDomain } = await import('../services/RemoteDirectoryService.js')
const app = express()
app.use('/', router)

const AP = 'application/activity+json'
const response = (body: unknown, status = 200, contentType = 'application/json', url = '') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: new Headers({ 'content-type': contentType }),
  json: async () => body,
  body: { cancel: async () => {} },
})

/** NodeInfo of `domain` naming `directory`; AP documents by URL. */
function serve(domain: string, directory: string | null, docs: Record<string, unknown>) {
  safeFetch.mockImplementation(async (url: string) => url === `https://${domain}/.well-known/nodeinfo`
    ? response({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `https://${domain}/nodeinfo/2.1` }] })
    : response({}, 404))
  signedApFetch.mockImplementation(async (url: string) => {
    if (url === `https://${domain}/nodeinfo/2.1`) {
      return response({ software: { name: 'harmony' }, metadata: directory ? { serverDirectory: directory } : {} })
    }
    return url in docs ? response(docs[url], 200, AP, url) : response({}, 404, 'text/html', url)
  })
}

const group = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Group', preferredUsername: id.split('/').pop(), name: `Name of ${id.split('/').pop()}`,
  summary: '<p>Hello &amp; welcome</p>', discoverable: true, 'harmony:memberCount': 4,
  icon: { type: 'Image', url: 'https://peer.test/icon.webp' }, ...extra,
})

const get = (path: string, auth = 'Bearer member') => supertest(app).get(path).set('Authorization', auth)

beforeEach(() => {
  store.clear()
  blockedHosts.clear()
  for (const k of Object.keys(tables)) delete tables[k]
  safeFetch.mockReset()
  signedApFetch.mockReset()
  rpc.mockClear()
  switches.inbound = true
  switches.outbound = true
})

describe('GET /directory/remote', () => {
  const DIR = 'https://peer.test/servers/directory'

  it('lists the listed Groups on the domain from the directory its NodeInfo names', async () => {
    serve('peer.test', DIR, {
      [DIR]: { id: DIR, type: 'OrderedCollection', totalItems: 9, first: `${DIR}?page=1` },
      [`${DIR}?page=1`]: {
        id: `${DIR}?page=1`, type: 'OrderedCollectionPage', next: `${DIR}?page=2`,
        orderedItems: [
          group('https://peer.test/servers/a'),
          group('https://elsewhere.test/servers/b'),
          group('https://peer.test/servers/c', { discoverable: false }),
          group('https://peer.test/servers/d', { 'harmony:public': false }),
          group('https://peer.test/servers/e', { 'harmony:federationEnabled': false }),
          { ...group('https://peer.test/servers/f'), type: 'Person' },
          'https://peer.test/servers/g',
          group('https://peer.test/servers/a'),
          group('https://peer.test/servers/h'),
        ],
      },
    })
    tables.servers = [{ id: 'copy-h', ap_id: 'https://peer.test/servers/h', is_local_server: false }]
    tables.instance_server_blocks = [{ server_id: 'copy-h', blocked: true }]

    const res = await get('/directory/remote?domain=https://Peer.test/')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      domain: 'peer.test',
      directory: DIR,
      totalItems: 9,
      next: `${DIR}?page=2`,
      items: [{
        id: 'https://peer.test/servers/a', name: 'Name of a', summary: 'Hello & welcome',
        icon: 'https://peer.test/icon.webp', memberCount: 4, handle: 'a@peer.test', category: null,
      }],
    })
    expect(rpc).toHaveBeenCalledWith('record_instance_directory', { p_domain: 'peer.test', p_directory: DIR })
    expect(signedApFetch).toHaveBeenCalledWith(DIR, expect.anything())
  })

  it('serves a second read from the cache', async () => {
    serve('peer.test', DIR, { [DIR]: { id: DIR, type: 'OrderedCollection', orderedItems: [group('https://peer.test/servers/a')] } })
    await get('/directory/remote?domain=peer.test')
    const calls = signedApFetch.mock.calls.length + safeFetch.mock.calls.length
    const again = await get('/directory/remote?domain=peer.test')
    expect(again.body.items).toHaveLength(1)
    expect(signedApFetch.mock.calls.length + safeFetch.mock.calls.length).toBe(calls)
  })

  it('reads a later page by its URL on the same domain only', async () => {
    serve('peer.test', DIR, {
      [`${DIR}?page=2`]: { id: `${DIR}?page=2`, type: 'OrderedCollectionPage', orderedItems: [group('https://peer.test/servers/z')], next: 'https://elsewhere.test/x' },
    })
    const res = await get(`/directory/remote?domain=peer.test&page=${encodeURIComponent(`${DIR}?page=2`)}`)
    expect(res.body.items.map((i: any) => i.id)).toEqual(['https://peer.test/servers/z'])
    expect(res.body.next).toBeNull()
    const other = await get(`/directory/remote?domain=peer.test&page=${encodeURIComponent('https://elsewhere.test/servers/directory?page=2')}`)
    expect(other.status).toBe(400)
    expect(other.body.code).toBe('invalid_page')
  })

  it('takes no directory on another host, or a collection served from another host', async () => {
    serve('peer.test', 'https://elsewhere.test/servers/directory', {})
    expect((await get('/directory/remote?domain=peer.test')).body.code).toBe('no_directory')
    store.clear()
    serve('peer.test', DIR, { [DIR]: { id: 'https://elsewhere.test/servers/directory', type: 'OrderedCollection', orderedItems: [] } })
    expect((await get('/directory/remote?domain=peer.test')).status).toBe(502)
  })

  it('answers 404 for an instance without a directory and 502 for one that does not answer', async () => {
    serve('peer.test', null, {})
    const none = await get('/directory/remote?domain=peer.test')
    expect([none.status, none.body.code]).toEqual([404, 'no_directory'])
    expect(rpc).toHaveBeenCalledWith('record_instance_directory', { p_domain: 'peer.test', p_directory: null })

    store.clear()
    safeFetch.mockResolvedValue(response({}, 503))
    const down = await get('/directory/remote?domain=down.test')
    expect([down.status, down.body.code]).toEqual([502, 'unreachable'])
  })

  it('refuses without a session, while federation is off, and for bad, own, private or blocked domains', async () => {
    expect((await get('/directory/remote?domain=peer.test', 'Bearer nobody')).status).toBe(401)

    switches.outbound = false
    expect((await get('/directory/remote?domain=peer.test')).body.code).toBe('INSTANCE_FEDERATION_OFF')
    switches.outbound = true
    switches.inbound = false
    expect((await get('/directory/remote?domain=peer.test')).body.code).toBe('INSTANCE_FEDERATION_OFF')
    switches.inbound = true

    expect((await get('/directory/remote?domain=not a domain')).body.code).toBe('invalid_domain')
    expect((await get('/directory/remote?domain=harmony.test')).body.code).toBe('own_instance')
    expect((await get('/directory/remote?domain=10.0.0.5')).body.code).toBe('invalid_domain')

    blockedHosts.add('peer.test')
    expect((await get('/directory/remote?domain=peer.test')).body.code).toBe('instance_blocked')
    blockedHosts.clear()
    tables.federated_instances = [{ domain: 'bad.test', is_blocked: true }]
    expect((await get('/directory/remote?domain=sub.bad.test')).body.code).toBe('instance_blocked')
    tables.blocked_instances = [{ domain: 'worse.test' }]
    expect((await get('/directory/remote?domain=worse.test')).body.code).toBe('instance_blocked')

    expect(safeFetch).not.toHaveBeenCalled()
    expect(signedApFetch).not.toHaveBeenCalled()
  })
})

describe('GET /directory/peers', () => {
  it('lists known instances that publish a directory, blocked ones left out, after reading due peers', async () => {
    tables.federated_instances = [
      { domain: 'peer.test', software: 'harmony', is_blocked: false, metadata: { server_directory: 'https://peer.test/servers/directory', directory_checked_at: new Date().toISOString(), icon_url: 'https://peer.test/i.webp' } },
      { domain: 'fresh.test', software: 'harmony', is_blocked: false, metadata: {} },
      { domain: 'gone.test', software: 'harmony', is_blocked: true, metadata: { server_directory: 'https://gone.test/servers/directory' } },
      { domain: 'muted.test', software: 'harmony', is_blocked: false, metadata: { server_directory: 'https://muted.test/servers/directory', directory_checked_at: new Date().toISOString() } },
    ]
    tables.blocked_instances = [{ domain: 'muted.test' }]
    serve('fresh.test', 'https://fresh.test/servers/directory', {})
    rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'record_instance_directory') {
        const row = tables.federated_instances.find((r) => r.domain === args.p_domain)
        if (row) row.metadata = { ...row.metadata, server_directory: args.p_directory, directory_checked_at: new Date().toISOString() }
      }
      return { data: true, error: null }
    })

    const res = await get('/directory/peers')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      federationOff: false,
      peers: [
        { domain: 'peer.test', software: 'harmony', icon: 'https://peer.test/i.webp' },
        { domain: 'fresh.test', software: 'harmony', icon: null },
      ],
    })
    expect(safeFetch).toHaveBeenCalledWith('https://fresh.test/.well-known/nodeinfo', expect.anything())
    expect(safeFetch).not.toHaveBeenCalledWith('https://peer.test/.well-known/nodeinfo', expect.anything())
  })

  it('lists nothing while federation is off, and nothing without a session', async () => {
    switches.outbound = false
    expect((await get('/directory/peers')).body).toEqual({ peers: [], federationOff: true })
    expect((await get('/directory/peers', '')).status).toBe(401)
  })
})

describe('directory domain and entry', () => {
  it('normalizes a domain or URL to host[:port]', () => {
    expect(normalizeDirectoryDomain(' HTTPS://Har.Mony.lol/explore ')).toBe('har.mony.lol')
    expect(normalizeDirectoryDomain('198.51.100.1:8443')).toBe('198.51.100.1:8443')
    expect(normalizeDirectoryDomain('peer.test:443')).toBe('peer.test')
    for (const bad of ['', 'a b', 'user@host.test', '-x.test', 'x..test', 42]) expect(normalizeDirectoryDomain(bad)).toBeNull()
  })

  it('keeps an https icon and a plain-text summary', () => {
    const entry = directoryEntry(group('https://peer.test/servers/a', {
      icon: [{ url: 'javascript:alert(1)' }], summary: 'line<br>next <script>x</script>',
      'harmony:memberCount': -1, 'harmony:category': 'gaming',
    }), 'peer.test')
    expect(entry).toMatchObject({ icon: null, summary: 'line\nnext x', memberCount: null, category: 'gaming' })
  })
})
