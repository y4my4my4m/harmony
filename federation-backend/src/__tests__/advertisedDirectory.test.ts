import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Servers advertised by the known instances, merged (routes/directory.ts GET /directory/servers,
// services/AdvertisedDirectoryService.ts): every known instance's listed Groups with the
// instance that hosts each, blocked instances never read, partial answers when one fails, kept
// fresh 15 minutes and served stale while read again, at most four instances read at once.

const cfg = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test', DIRECTORY_ALLOW_PORTS: false }))
vi.mock('../config/index.js', () => ({ default: cfg }))
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
vi.mock('../services/BlockedInstancesCache.js', () => ({ BlockedInstancesCache: { isBlocked: () => false } }))

// Entries expire by Date.now(), which the tests move.
const store = vi.hoisted(() => new Map<string, { value: unknown; until: number }>())
vi.mock('../utils/cache.js', () => ({
  cache: {
    getAsync: async (key: string) => {
      const hit = store.get(key)
      return hit && hit.until > Date.now() ? hit.value : undefined
    },
    set: (key: string, value: unknown, ttl = 300) => { store.set(key, { value, until: Date.now() + ttl * 1000 }); return true },
  },
}))

const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: (...args: any[]) => safeFetch(...args),
  validateExternalHostname: () => {},
}))
const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: { signedApFetch } }))

const tables = vi.hoisted(() => ({} as Record<string, any[]>))
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: true, error: null })))
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

const AP = 'application/activity+json'
const response = (body: unknown, status = 200, contentType = 'application/json', url = '') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: new Headers({ 'content-type': contentType }),
  json: async () => body,
  body: { cancel: async () => {} },
})

interface Peer {
  name?: string
  icon?: string
  groups: Array<{ slug: string; name?: string; members?: number; discoverable?: boolean }>
  /** NodeInfo answers 503. */
  down?: boolean
  /** Awaited before the directory page answers. */
  gate?: () => Promise<void>
}
const peers: Record<string, Peer> = {}
let inFlight = 0
let maxInFlight = 0

const host = (url: string) => new URL(url).host
const dir = (domain: string) => `https://${domain}/servers/directory`

function installFetches() {
  safeFetch.mockImplementation(async (url: string) => {
    const peer = peers[host(url)]
    if (!peer || peer.down) return response({}, 503)
    return response({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `https://${host(url)}/nodeinfo/2.1` }] })
  })
  signedApFetch.mockImplementation(async (url: string) => {
    const domain = host(url)
    const peer = peers[domain]
    if (!peer) return response({}, 404, 'text/html', url)
    if (url.endsWith('/nodeinfo/2.1')) {
      return response({ software: { name: 'harmony' }, metadata: { serverDirectory: dir(domain), nodeName: peer.name, icon: peer.icon } })
    }
    if (url === dir(domain)) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await peer.gate?.()
        return response({
          id: dir(domain), type: 'OrderedCollection',
          orderedItems: peer.groups.map((g) => ({
            id: `https://${domain}/servers/${g.slug}`, type: 'Group', preferredUsername: g.slug,
            name: g.name ?? `Server ${g.slug}`, summary: `About ${g.slug}`, discoverable: g.discoverable ?? true,
            'harmony:memberCount': g.members ?? 1,
          })),
        }, 200, AP, url)
      } finally {
        inFlight--
      }
    }
    return response({}, 404, 'text/html', url)
  })
}

function known(domain: string, extra: Record<string, unknown> = {}) {
  return {
    domain, software: 'harmony', is_blocked: false,
    metadata: { server_directory: dir(domain), directory_checked_at: new Date().toISOString() },
    ...extra,
  }
}

let app: express.Express
const get = (path: string, auth = 'Bearer member') => supertest(app).get(path).set('Authorization', auth)
const pageReads = (domain: string) => signedApFetch.mock.calls.filter(([url]) => url === dir(domain)).length

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
  vi.resetModules()
  store.clear()
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(peers)) delete peers[k]
  safeFetch.mockReset()
  signedApFetch.mockReset()
  installFetches()
  inFlight = 0
  maxInFlight = 0
  switches.inbound = true
  switches.outbound = true
  const { default: router } = await import('../routes/directory.js')
  app = express()
  app.use('/', router)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /directory/servers', () => {
  it('merges the servers every known instance lists, most members first, each with its instance', async () => {
    peers['a.test'] = { name: 'Alpha <b>Hall</b>', icon: '/brand/icon.png', groups: [{ slug: 'a1', members: 5 }, { slug: 'a2', members: 50 }] }
    peers['b.test'] = { groups: [{ slug: 'b1', members: 20 }, { slug: 'b2', members: 99, discoverable: false }] }
    peers['c.test'] = { groups: [{ slug: 'c1', members: 1000 }] }
    peers['d.test'] = { groups: [{ slug: 'd1', members: 1000 }] }
    tables.federated_instances = [
      known('a.test'),
      known('b.test', { metadata: { ...known('b.test').metadata, icon_url: 'https://b.test/i.webp' } }),
      known('c.test', { is_blocked: true }),
      known('d.test'),
      known('harmony.test'),
    ]
    tables.blocked_instances = [{ domain: 'd.test' }]

    const res = await get('/directory/servers')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body.items.map((i: any) => i.id)).toEqual([
      'https://a.test/servers/a2', 'https://b.test/servers/b1', 'https://a.test/servers/a1',
    ])
    expect(res.body.items[0]).toEqual({
      id: 'https://a.test/servers/a2', name: 'Server a2', summary: 'About a2', icon: null, memberCount: 50,
      handle: 'a2@a.test', category: null,
      instance: { domain: 'a.test', name: 'Alpha Hall', icon: 'https://a.test/brand/icon.png' },
    })
    expect(res.body.items[1].instance).toEqual({ domain: 'b.test', name: null, icon: 'https://b.test/i.webp' })
    expect(res.body).toMatchObject({ total: 3, nextOffset: null, instances: 2, pending: 0, failed: [], federationOff: false })
    for (const blocked of ['c.test', 'd.test', 'harmony.test']) {
      expect(signedApFetch.mock.calls.some(([url]) => host(url) === blocked)).toBe(false)
      expect(safeFetch.mock.calls.some(([url]) => host(url) === blocked)).toBe(false)
    }
  })

  it('filters by name, summary or instance and pages at most 60 at a time', async () => {
    peers['a.test'] = { name: 'Alpha', groups: Array.from({ length: 45 }, (_, i) => ({ slug: `a${i}`, members: 100 - i })) }
    peers['b.test'] = { name: 'Beta', groups: [
      ...Array.from({ length: 39 }, (_, i) => ({ slug: `b${i}`, members: 10 })),
      { slug: 'zebra', name: 'Ｚebra Crossing', members: 3 },
    ] }
    tables.federated_instances = [known('a.test'), known('b.test')]

    const first = await get('/directory/servers?limit=500')
    // 40 Groups kept from each instance's page.
    expect(first.body.total).toBe(80)
    expect(first.body.items).toHaveLength(60)
    expect(first.body.nextOffset).toBe(60)
    const rest = await get('/directory/servers?offset=60&limit=60')
    expect(rest.body.items).toHaveLength(20)
    expect(rest.body.nextOffset).toBeNull()
    expect(new Set([...first.body.items, ...rest.body.items].map((i: any) => i.id)).size).toBe(80)

    const zebra = await get(`/directory/servers?q=${encodeURIComponent('  zEBRA ')}`)
    expect(zebra.body.items.map((i: any) => i.handle)).toEqual(['zebra@b.test'])
    expect((await get('/directory/servers?q=beta')).body.total).toBe(40)
    expect((await get('/directory/servers?q=about%20a3')).body.items.map((i: any) => i.handle))
      .toEqual(['a3@a.test', 'a30@a.test', 'a31@a.test', 'a32@a.test', 'a33@a.test', 'a34@a.test', 'a35@a.test', 'a36@a.test', 'a37@a.test', 'a38@a.test', 'a39@a.test'])
    expect((await get('/directory/servers?q=nothing-matches')).body).toMatchObject({ items: [], total: 0, instances: 2 })
    // Filtering is served from the snapshots: each instance's page was read once.
    expect(pageReads('a.test')).toBe(1)
    expect(pageReads('b.test')).toBe(1)
  })

  it('answers with the instances that answered and names the one that failed', async () => {
    peers['a.test'] = { groups: [{ slug: 'a1' }] }
    peers['down.test'] = { down: true, groups: [{ slug: 'x' }] }
    tables.federated_instances = [known('a.test'), known('down.test')]

    const res = await get('/directory/servers')
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: any) => i.id)).toEqual(['https://a.test/servers/a1'])
    expect(res.body).toMatchObject({ instances: 1, failed: ['down.test'], pending: 0 })

    const calls = safeFetch.mock.calls.length
    vi.setSystemTime(Date.now() + 60_000)
    await get('/directory/servers')
    expect(safeFetch.mock.calls.length).toBe(calls)
    vi.setSystemTime(Date.now() + 2 * 60_000)
    peers['down.test'].down = false
    store.clear()
    const back = await get('/directory/servers')
    expect(back.body.items.map((i: any) => i.id)).toEqual(['https://a.test/servers/a1', 'https://down.test/servers/x'])
    expect(back.body.failed).toEqual([])
  })

  it('keeps an instance\'s servers 15 minutes, then serves them while reading again, until 6 hours old', async () => {
    peers['a.test'] = { groups: [{ slug: 'old' }] }
    tables.federated_instances = [known('a.test')]
    expect((await get('/directory/servers')).body.items.map((i: any) => i.handle)).toEqual(['old@a.test'])
    expect(pageReads('a.test')).toBe(1)

    vi.setSystemTime(Date.now() + 10 * 60_000)
    await get('/directory/servers')
    expect(pageReads('a.test')).toBe(1)

    vi.setSystemTime(Date.now() + 6 * 60_000)
    let open!: () => void
    peers['a.test'] = { groups: [{ slug: 'new' }], gate: () => new Promise<void>((resolve) => { open = resolve }) }
    const stale = await get('/directory/servers')
    expect(stale.body.items.map((i: any) => i.handle)).toEqual(['old@a.test'])
    await vi.waitFor(() => expect(pageReads('a.test')).toBe(2))
    open()
    await vi.waitFor(async () => {
      expect((await get('/directory/servers')).body.items.map((i: any) => i.handle)).toEqual(['new@a.test'])
    })

    vi.setSystemTime(Date.now() + 7 * 3600_000)
    peers['a.test'] = { down: true, groups: [] }
    store.clear()
    const expired = await get('/directory/servers')
    expect(expired.body).toMatchObject({ items: [], failed: ['a.test'], instances: 0 })
  })

  it('reads at most four instances at once', async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 20))
    for (let i = 0; i < 9; i++) peers[`p${i}.test`] = { groups: [{ slug: `s${i}` }], gate: slow }
    tables.federated_instances = Object.keys(peers).map((d) => known(d))

    const res = await get('/directory/servers')
    expect(res.body.items).toHaveLength(9)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  it('drops a Group this instance blocked after its instance was read', async () => {
    peers['a.test'] = { groups: [{ slug: 'a1', members: 2 }, { slug: 'a2', members: 1 }] }
    tables.federated_instances = [known('a.test')]
    expect((await get('/directory/servers')).body.items).toHaveLength(2)
    tables.servers = [{ id: 'copy-a1', ap_id: 'https://a.test/servers/a1', is_local_server: false }]
    tables.instance_server_blocks = [{ server_id: 'copy-a1', blocked: true }]
    expect((await get('/directory/servers')).body.items.map((i: any) => i.handle)).toEqual(['a2@a.test'])
  })

  it('lists nothing and reads nothing while federation is off, and refuses without a session', async () => {
    peers['a.test'] = { groups: [{ slug: 'a1' }] }
    tables.federated_instances = [known('a.test')]
    switches.inbound = false
    expect((await get('/directory/servers')).body).toEqual({
      items: [], total: 0, nextOffset: null, instances: 0, pending: 0, failed: [], federationOff: true,
    })
    switches.inbound = true
    switches.outbound = false
    expect((await get('/directory/servers')).body.federationOff).toBe(true)
    switches.outbound = true
    expect((await get('/directory/servers', 'Bearer nobody')).status).toBe(401)
    expect(safeFetch).not.toHaveBeenCalled()
    expect(signedApFetch).not.toHaveBeenCalled()
  })
})
