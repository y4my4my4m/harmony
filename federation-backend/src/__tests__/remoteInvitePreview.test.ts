import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Invite links to servers on other Harmony instances (services/remoteInvitePreview.ts,
// routes/remoteInvite.ts): a host is read only when its NodeInfo names Harmony, the card is its
// /api/federation/invites/<code> answer kept to capped plain text, counts and https URLs, and
// nothing is read for a blocked, private or non-https host, or while federation is off.

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
vi.mock('../utils/userAgent.js', () => ({ federationUserAgent: () => 'Harmony/test' }))

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
    if (host.startsWith('10.') || host === 'localhost') throw new Error('Blocked private IP')
  },
}))
const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: { signedApFetch } }))

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        limit: () => q,
        then: (resolve: any) => resolve({ data: [], error: null }),
      }
      return q
    },
  }),
}))

const { default: router } = await import('../routes/remoteInvite.js')
const { resolveRemoteInvite, remoteInviteTarget, cleanText } = await import('../services/remoteInvitePreview.js')
const app = express()
app.use('/', router)

const response = (body: unknown, status = 200, url = '') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => {
    if (typeof body === 'string') throw new SyntaxError('Unexpected token')
    return body
  },
  body: { cancel: async () => {} },
})

const NODEINFO = { software: { name: 'harmony', version: '1.9.4' }, metadata: { nodeName: 'Peer Harmony', icon: '/icon.png' } }
const GROUP = 'https://peer.test/servers/0b0e0000-0000-4000-8000-0000000000a1'

function invite(server: Record<string, unknown> = {}) {
  return {
    code: 'GOODCODE',
    server: {
      id: GROUP, serverId: '0b0e0000-0000-4000-8000-0000000000a1', name: 'Timbre',
      description: 'Alternative Har.mony client', icon: 'https://db.peer.test/storage/v1/object/public/server_icons/a.png',
      memberCount: 6, onlineCount: 2, channels: [], inbox: `${GROUP}/inbox`, federationEnabled: true,
      ...server,
    },
  }
}

/** NodeInfo of peer.test (Harmony unless `nodeinfo` says otherwise) and its invite answers by code. */
function serve(answers: Record<string, ReturnType<typeof response> | Error>, nodeinfo: unknown = NODEINFO) {
  safeFetch.mockImplementation(async (url: string) => {
    if (url === 'https://peer.test/.well-known/nodeinfo') {
      return response({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://peer.test/nodeinfo/2.1' }] })
    }
    const code = url.match(/^https:\/\/peer\.test\/api\/federation\/invites\/([^/?]+)$/)?.[1]
    const answer = code ? answers[code] : undefined
    if (answer instanceof Error) throw answer
    return answer ?? response({ error: 'Invite not found' }, 404, url)
  })
  signedApFetch.mockImplementation(async (url: string) =>
    url === 'https://peer.test/nodeinfo/2.1' ? response(nodeinfo) : response({}, 404))
}

const inviteFetches = () => safeFetch.mock.calls.filter(([url]) => String(url).includes('/api/federation/invites/'))

beforeEach(() => {
  store.clear()
  blockedHosts.clear()
  safeFetch.mockReset()
  signedApFetch.mockReset()
  switches.inbound = true
  switches.outbound = true
})

describe('remoteInviteTarget', () => {
  it('reads https invite links on other hosts', () => {
    expect(remoteInviteTarget('https://peer.test/invite/GOODCODE')).toEqual({ domain: 'peer.test', code: 'GOODCODE' })
    expect(remoteInviteTarget('https://Peer.Test:443/invite/GOODCODE/')).toEqual({ domain: 'peer.test', code: 'GOODCODE' })
  })

  it.each([
    'http://peer.test/invite/GOODCODE',
    'https://harmony.test/invite/GOODCODE',
    'https://user:pass@peer.test/invite/GOODCODE',
    'https://peer.test:8443/invite/GOODCODE',
    'https://peer.test/invite/GOOD/CODE',
    'https://peer.test/invites/GOODCODE',
    'https://peer.test/invite/<b>',
    'javascript:alert(1)//peer.test/invite/GOODCODE',
    42,
  ])('reads nothing of %s', (url) => {
    expect(remoteInviteTarget(url)).toBeNull()
  })
})

describe('resolveRemoteInvite', () => {
  it('answers the card of a Harmony host, with the instance named by NodeInfo', async () => {
    serve({ GOODCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/GOODCODE') })
    const lookup = await resolveRemoteInvite('https://peer.test/invite/GOODCODE')
    expect(lookup).toEqual({
      status: 'card',
      card: {
        status: 'valid', code: 'GOODCODE', domain: 'peer.test',
        instance: { name: 'Peer Harmony', icon: 'https://peer.test/icon.png' },
        server: {
          name: 'Timbre', description: 'Alternative Har.mony client',
          icon: 'https://db.peer.test/storage/v1/object/public/server_icons/a.png',
          memberCount: 6, onlineCount: 2, id: GROUP,
        },
      },
    })
    const [url, init] = inviteFetches()[0]
    expect(url).toBe('https://peer.test/api/federation/invites/GOODCODE')
    expect(init).toMatchObject({ timeoutMs: 5000, maxBodyBytes: 256 * 1024 })
  })

  it('reads nothing more of a host whose NodeInfo names other software', async () => {
    serve({ GOODCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/GOODCODE') },
      { software: { name: 'mastodon' }, metadata: { nodeName: 'Not Harmony' } })
    expect(await resolveRemoteInvite('https://peer.test/invite/GOODCODE')).toEqual({ status: 'none' })
    expect(inviteFetches()).toHaveLength(0)
  })

  it('reads nothing more of a host without NodeInfo', async () => {
    safeFetch.mockResolvedValue(response({}, 404))
    expect(await resolveRemoteInvite('https://peer.test/invite/GOODCODE')).toEqual({ status: 'none' })
    expect(inviteFetches()).toHaveLength(0)
  })

  it('fetches nothing for a private, blocked or own host, or while federation is off', async () => {
    serve({ GOODCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/GOODCODE') })
    expect(await resolveRemoteInvite('https://10.0.0.5/invite/GOODCODE')).toEqual({ status: 'none' })
    expect(await resolveRemoteInvite('https://localhost/invite/GOODCODE')).toEqual({ status: 'none' })
    expect(await resolveRemoteInvite('https://harmony.test/invite/GOODCODE')).toEqual({ status: 'none' })
    blockedHosts.add('peer.test')
    expect(await resolveRemoteInvite('https://peer.test/invite/GOODCODE')).toEqual({ status: 'none' })
    blockedHosts.clear()
    switches.outbound = false
    expect(await resolveRemoteInvite('https://peer.test/invite/GOODCODE')).toEqual({ status: 'none' })
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('caps and flattens text, keeps counts to non-negative integers and URLs to https on the host', async () => {
    serve({
      LONGCODE: response(invite({
        name: `  ${'N'.repeat(140)}‮ `,
        description: `line one\n\n\tline​ two ${'d'.repeat(400)}`,
        icon: 'http://db.peer.test/a.png',
        memberCount: -3,
        onlineCount: 2.5,
        id: 'https://elsewhere.test/servers/0b0e0000-0000-4000-8000-0000000000a1',
      }), 200, 'https://peer.test/api/federation/invites/LONGCODE'),
      ODDCODE: response(invite({ icon: '/default_server.webp', memberCount: '6', onlineCount: null, description: '   ' }),
        200, 'https://peer.test/api/federation/invites/ODDCODE'),
    })
    const long = await resolveRemoteInvite('https://peer.test/invite/LONGCODE')
    const server = long.status === 'card' ? long.card.server! : null
    expect(Array.from(server!.name)).toHaveLength(100)
    expect(server!.name.endsWith('…')).toBe(true)
    expect(Array.from(server!.description!)).toHaveLength(300)
    expect(server!.description!.startsWith('line one line two d')).toBe(true)
    expect(server).toMatchObject({ icon: null, memberCount: null, onlineCount: null, id: null })

    const odd = await resolveRemoteInvite('https://peer.test/invite/ODDCODE')
    expect(odd.status === 'card' && odd.card.server).toMatchObject({ icon: null, memberCount: null, onlineCount: null, description: null })
  })

  it('answers invalid for a dead invite and closed for a server shut to other instances', async () => {
    serve({
      GONECODE: response({ error: 'Invite has expired' }, 410, 'https://peer.test/api/federation/invites/GONECODE'),
      SHUTCODE: response({ code: 'federation_disabled' }, 403, 'https://peer.test/api/federation/invites/SHUTCODE'),
    })
    const gone = await resolveRemoteInvite('https://peer.test/invite/GONECODE')
    expect(gone).toEqual({ status: 'card', card: { status: 'invalid', code: 'GONECODE', domain: 'peer.test', instance: { name: 'Peer Harmony', icon: 'https://peer.test/icon.png' } } })
    expect(await resolveRemoteInvite('https://peer.test/invite/MISSCODE')).toMatchObject({ status: 'card', card: { status: 'invalid' } })
    expect(await resolveRemoteInvite('https://peer.test/invite/SHUTCODE')).toMatchObject({ status: 'card', card: { status: 'closed' } })
  })

  it('answers unavailable for an oversized, malformed, misplaced or failed answer', async () => {
    serve({
      BIGCODE: new Error('safeFetch: response body exceeded 262144 bytes (received 300000)'),
      JUNKCODE: response('<html>', 200, 'https://peer.test/api/federation/invites/JUNKCODE'),
      NONECODE: response({ server: { name: '   ' } }, 200, 'https://peer.test/api/federation/invites/NONECODE'),
      AWAYCODE: response(invite(), 200, 'https://elsewhere.test/api/federation/invites/AWAYCODE'),
      FAILCODE: response({ error: 'down' }, 503, 'https://peer.test/api/federation/invites/FAILCODE'),
      DENYCODE: response({ error: 'Forbidden' }, 403, 'https://peer.test/api/federation/invites/DENYCODE'),
    })
    for (const code of ['BIGCODE', 'JUNKCODE', 'NONECODE', 'AWAYCODE', 'FAILCODE', 'DENYCODE']) {
      expect(await resolveRemoteInvite(`https://peer.test/invite/${code}`), code).toEqual({ status: 'unavailable' })
    }
  })

  it('reads a card and the host once per cache window', async () => {
    serve({ GOODCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/GOODCODE') })
    await resolveRemoteInvite('https://peer.test/invite/GOODCODE')
    await resolveRemoteInvite('https://peer.test/invite/GOODCODE')
    await resolveRemoteInvite('https://peer.test/invite/OTHERCODE')
    expect(inviteFetches()).toHaveLength(2)
    expect(signedApFetch).toHaveBeenCalledTimes(1)
  })

  it('shares one read among concurrent lookups of a host and of a card', async () => {
    serve({
      ACODE: response(invite(), 200, 'https://peer.test/api/federation/invites/ACODE'),
      BCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/BCODE'),
    })
    const lookups = await Promise.all([
      resolveRemoteInvite('https://peer.test/invite/ACODE'),
      resolveRemoteInvite('https://peer.test/invite/ACODE'),
      resolveRemoteInvite('https://peer.test/invite/BCODE'),
    ])
    expect(lookups.map((l) => l.status)).toEqual(['card', 'card', 'card'])
    expect(signedApFetch).toHaveBeenCalledTimes(1)
    expect(inviteFetches().map(([url]) => url)).toEqual([
      'https://peer.test/api/federation/invites/ACODE',
      'https://peer.test/api/federation/invites/BCODE',
    ])
  })
})

describe('cleanText', () => {
  it('keeps one line of visible text', () => {
    expect(cleanText('a\u0000b⁦c\r\nd', 10)).toBe('a b c d')
    expect(cleanText('​‏', 10)).toBeNull()
    expect(cleanText(7, 10)).toBeNull()
  })
})

describe('GET /remote-invite', () => {
  const get = (url: string, auth = 'Bearer member') =>
    supertest(app).get(`/remote-invite?url=${encodeURIComponent(url)}`).set('Authorization', auth)

  it('answers the card to a signed-in local user', async () => {
    serve({ GOODCODE: response(invite(), 200, 'https://peer.test/api/federation/invites/GOODCODE') })
    const res = await get('https://peer.test/invite/GOODCODE')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body.invite).toMatchObject({ status: 'valid', domain: 'peer.test', server: { name: 'Timbre', onlineCount: 2 } })
  })

  it('refuses a caller without a session, a link that is no invite, and a host that is not Harmony', async () => {
    serve({}, { software: { name: 'misskey' } })
    expect((await get('https://peer.test/invite/GOODCODE', 'Bearer nobody')).status).toBe(401)
    expect((await get('https://peer.test/about')).body.code).toBe('invalid_url')
    const notHarmony = await get('https://peer.test/invite/GOODCODE')
    expect(notHarmony.status).toBe(404)
    expect(notHarmony.body.code).toBe('not_harmony')
  })

  it('answers 502 when a Harmony host does not answer', async () => {
    serve({ GOODCODE: new Error('safeFetch: timeout after 5000ms') })
    const res = await get('https://peer.test/invite/GOODCODE')
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('unreachable')
  })
})
