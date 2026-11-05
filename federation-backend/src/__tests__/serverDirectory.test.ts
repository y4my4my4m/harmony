import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// The server directory (activitypub/serverDirectory.ts): GET /servers/directory is an
// OrderedCollection of the listed Groups, paged by OrderedCollectionPage, read through
// federation_server_directory. A Group says discoverable true when listed, false when private,
// nothing when public and not listed, and harmony:public always; consumers read harmony:public,
// else discoverable as hosts before 1.9.3 wrote it.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../utils/urlUtils.js', () => ({
  getFullServerIconUrl: (icon: string | null) => (icon ? `https://harmony.test/storage/${icon}` : null),
}))
const switches = vi.hoisted(() => ({ inbound: true, outbound: true }))
vi.mock('../services/FederationSwitches.js', () => ({ federationSwitches: async () => switches }))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc }) }))

const {
  default: router,
  directoryGroup,
  groupDiscoverability,
  groupIsPublic,
  isListedAcrossFederation,
} = await import('../activitypub/serverDirectory.js')

const app = express()
app.use('/', router)

const row = (n: number, total: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  slug: `hall-${n}`,
  name: `Hall ${n}`,
  description: `About ${n}`,
  icon: null,
  banner: null,
  category: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: null,
  member_count: 10 - n,
  total_count: total,
  ...extra,
})

beforeEach(() => {
  rpc.mockReset()
  switches.inbound = true
  switches.outbound = true
})

describe('listing rule', () => {
  const listed = { is_local_server: true, public: true, federation_enabled: true, federation_discoverable: true, suspended_at: null }

  it('lists a public, federated, unsuspended server with the flag on while the instance federates', () => {
    expect(isListedAcrossFederation(listed, true)).toBe(true)
    expect(isListedAcrossFederation(listed, false)).toBe(false)
    for (const change of [
      { public: false }, { federation_enabled: false }, { federation_discoverable: false },
      { suspended_at: '2026-11-01T00:00:00Z' }, { is_local_server: false },
    ]) {
      expect(isListedAcrossFederation({ ...listed, ...change }, true)).toBe(false)
    }
  })

  it('says discoverable when listed, false when private, nothing when public and unlisted', () => {
    expect(groupDiscoverability(listed, true)).toEqual({ discoverable: true, 'harmony:public': true })
    expect(groupDiscoverability({ ...listed, federation_discoverable: false }, true)).toEqual({ 'harmony:public': true })
    expect(groupDiscoverability(listed, false)).toEqual({ 'harmony:public': true })
    expect(groupDiscoverability({ ...listed, public: false }, true)).toEqual({ discoverable: false, 'harmony:public': false })
  })

  it('reads a Group as public from harmony:public, else from discoverable as before 1.9.3', () => {
    expect(groupIsPublic({ 'harmony:public': true, discoverable: false })).toBe(true)
    expect(groupIsPublic({ 'harmony:public': false, discoverable: true })).toBe(false)
    expect(groupIsPublic({})).toBe(true)
    expect(groupIsPublic({ discoverable: false })).toBe(false)
    expect(groupIsPublic({ discoverable: true })).toBe(true)
  })
})

describe('GET /servers/directory', () => {
  it('is an OrderedCollection naming its first page', async () => {
    rpc.mockResolvedValue({ data: [row(1, 3)], error: null })
    const res = await supertest(app).get('/servers/directory')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/activity\+json/)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toMatchObject({
      id: 'https://harmony.test/servers/directory',
      type: 'OrderedCollection',
      totalItems: 3,
      first: 'https://harmony.test/servers/directory?page=1',
    })
    expect(res.body['@context'][1]).toMatchObject({ discoverable: 'toot:discoverable', harmony: 'https://mony.lol/ns#' })
  })

  it('pages Groups with next and prev', async () => {
    rpc.mockResolvedValue({ data: [row(21, 45), row(22, 45)], error: null })
    const res = await supertest(app).get('/servers/directory?page=2')
    expect(rpc).toHaveBeenCalledWith('federation_server_directory', { p_limit: 20, p_offset: 20 })
    expect(res.body).toMatchObject({
      id: 'https://harmony.test/servers/directory?page=2',
      type: 'OrderedCollectionPage',
      partOf: 'https://harmony.test/servers/directory',
      totalItems: 45,
      next: 'https://harmony.test/servers/directory?page=3',
      prev: 'https://harmony.test/servers/directory?page=1',
    })
    expect(res.body.orderedItems.map((g: any) => g.id)).toEqual([
      'https://harmony.test/servers/00000000-0000-4000-8000-000000000021',
      'https://harmony.test/servers/00000000-0000-4000-8000-000000000022',
    ])
  })

  it('ends without next on the last page, and an empty page past the end keeps the count', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: [row(1, 1)], error: null })
    const res = await supertest(app).get('/servers/directory?page=2')
    expect(res.body.orderedItems).toEqual([])
    expect(res.body.totalItems).toBe(1)
    expect(res.body.next).toBeUndefined()
  })

  it('refuses a page that is not a positive integer, and pages past the cap', async () => {
    expect((await supertest(app).get('/servers/directory?page=0')).status).toBe(400)
    expect((await supertest(app).get('/servers/directory?page=x')).status).toBe(400)
    expect((await supertest(app).get('/servers/directory?page=501')).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 503 when the directory cannot be read', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    expect((await supertest(app).get('/servers/directory')).status).toBe(503)
    expect((await supertest(app).get('/servers/directory?page=1')).status).toBe(503)
  })
})

describe('directory item', () => {
  it('is the Group\'s public summary', () => {
    expect(directoryGroup(row(3, 1, { icon: 'servers/3/icon.webp', category: 'gaming', updated_at: '2026-11-02T00:00:00.000Z' }))).toEqual({
      id: 'https://harmony.test/servers/00000000-0000-4000-8000-000000000003',
      type: 'Group',
      preferredUsername: 'hall-3',
      name: 'Hall 3',
      summary: 'About 3',
      inbox: 'https://harmony.test/servers/00000000-0000-4000-8000-000000000003/inbox',
      outbox: 'https://harmony.test/servers/00000000-0000-4000-8000-000000000003/outbox',
      icon: { type: 'Image', url: 'https://harmony.test/storage/servers/3/icon.webp', mediaType: 'image/webp' },
      published: '2026-11-01T00:00:00.000Z',
      updated: '2026-11-02T00:00:00.000Z',
      discoverable: true,
      'harmony:public': true,
      'harmony:federationEnabled': true,
      'harmony:memberCount': 7,
      'harmony:category': 'gaming',
    })
  })
})
