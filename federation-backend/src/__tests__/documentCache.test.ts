import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import compression from 'compression'
import supertest from 'supertest'
import { EventEmitter } from 'node:events'

// Public ActivityPub documents served once per window: concurrent identical requests share one
// build, later ones are hits until the max-age or the cache's own limit, and nothing that
// depends on the requester, its cookies or its signature is stored.

vi.mock('../config/index.js', () => ({
  default: { DOCUMENT_CACHE_TTL_MS: 30000 },
  config: { DOCUMENT_CACHE_TTL_MS: 30000 },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const published: Array<[string, string]> = []
const subscriber = Object.assign(new EventEmitter(), { subscribe: vi.fn(async () => 1) })
vi.mock('../services/RedisService.js', () => ({
  redis: {
    getClient: () => ({ publish: async (channel: string, message: string) => { published.push([channel, message]); return 1 } }),
    getSubscriber: () => subscriber,
  },
}))

const {
  documentCache, invalidateDocuments, subscribeDocumentInvalidation, clearDocumentCache,
  postDocumentPaths, accountDocumentPaths, documentCacheSize,
} = await import('../middleware/documentCache.js')

const AP = 'application/activity+json'
let builds: Record<string, number>
let gate: Promise<void> | null

/** Each route counts its builds; `gate` holds them open to line requests up. */
function app() {
  const a = express()
  a.use(compression({ threshold: 0 }))
  a.use(documentCache())
  const route = (path: string, respond: (req: express.Request, res: express.Response) => unknown) =>
    a.get(path, async (req, res) => {
      builds[req.path] = (builds[req.path] ?? 0) + 1
      if (gate) await gate
      respond(req, res)
    })
  route('/users/:name', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('RateLimit-Remaining', '41')
    res.type('application/activity+json').json({ id: `https://harmony.test/users/${req.params.name}`, page: req.query.page ?? null })
  })
  route('/users/:name/featured', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=1')
    res.json({ type: 'OrderedCollection' })
  })
  route('/posts/:id', (req, res) => {
    if (req.params.id.startsWith('00000000')) {
      res.setHeader('Cache-Control', 'private, no-store')
      return res.json({ private: true })
    }
    if (req.params.id.startsWith('11111111')) {
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.setHeader('Vary', 'Signature')
      return res.json({ bySigner: true })
    }
    if (req.params.id.startsWith('22222222')) return res.status(404).json({ error: 'Post not found' })
    if (req.params.id.startsWith('33333333')) {
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.cookie('seen', '1')
      return res.json({ cookie: true })
    }
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Vary', 'Accept')
    return res.json({ id: req.params.id })
  })
  route('/users/:name/outbox', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({ page: req.query.page, filler: 'x'.repeat(900 * 1024) })
  })
  route('/servers/:id', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({ type: 'Group' })
  })
  return a
}

const POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

beforeEach(() => {
  clearDocumentCache()
  builds = {}
  gate = null
  published.length = 0
})
afterEach(() => vi.useRealTimers())

describe('documentCache', () => {
  it('builds once for concurrent identical requests and serves the rest from the first', async () => {
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const server = app()
    const requests = Array.from({ length: 20 }, () => supertest(server).get('/users/alice').set('Accept', AP))
    const pending = Promise.all(requests.map((r) => r.then((res) => res)))
    await new Promise((r) => setTimeout(r, 50))
    open()
    const responses = await pending
    expect(builds['/users/alice']).toBe(1)
    expect(responses.every((r) => r.status === 200 && r.body.id === 'https://harmony.test/users/alice')).toBe(true)
    expect(responses.map((r) => r.headers['x-harmony-cache']).sort()).toEqual(['miss', ...Array(19).fill('shared')])
  })

  it('serves later requests as hits, compressed for whoever asks, without per-client headers', async () => {
    const server = app()
    const first = await supertest(server).get('/users/alice').set('Accept', AP)
    const hit = await supertest(server).get('/users/alice').set('Accept', AP).set('Accept-Encoding', 'gzip')
    expect(builds['/users/alice']).toBe(1)
    expect(hit.headers['x-harmony-cache']).toBe('hit')
    expect(hit.headers['content-encoding']).toBe('gzip')
    expect(hit.body).toEqual(first.body)
    expect(hit.headers['cache-control']).toBe('public, max-age=300')
    expect(hit.headers['ratelimit-remaining']).toBeUndefined()
  })

  it('keys by the query and by the Accept class, and leaves HTML alone', async () => {
    const server = app()
    await supertest(server).get('/users/alice?page=1').set('Accept', AP)
    await supertest(server).get('/users/alice?page=2').set('Accept', AP)
    await supertest(server).get('/users/alice?page=1').set('Accept', AP)
    expect(builds['/users/alice']).toBe(2)
    await supertest(server).get('/users/alice').set('Accept', 'text/html')
    await supertest(server).get('/users/alice').set('Accept', 'text/html')
    expect(builds['/users/alice']).toBe(4)
  })

  it('stores nothing private, signer-dependent, missing or setting a cookie', async () => {
    const server = app()
    for (const id of ['00000000', '11111111', '22222222', '33333333']) {
      const path = `/posts/${id}-0000-4000-8000-000000000000`
      await supertest(server).get(path).set('Accept', AP)
      const again = await supertest(server).get(path).set('Accept', AP)
      expect(again.headers['x-harmony-cache']).toBe('miss')
      expect(builds[path]).toBe(2)
    }
  })

  it('lets each waiter build its own answer when the first is not storable', async () => {
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const server = app()
    const path = '/posts/00000000-0000-4000-8000-000000000000'
    const pending = Promise.all(Array.from({ length: 5 }, () => supertest(server).get(path).set('Accept', AP).then((r) => r)))
    await new Promise((r) => setTimeout(r, 50))
    open()
    const responses = await pending
    expect(responses.every((r) => r.status === 200 && r.body.private === true)).toBe(true)
    expect(builds[path]).toBe(5)
  })

  it('caches only the paths whose answers do not depend on the requester', async () => {
    const server = app()
    await supertest(server).get('/servers/x').set('Accept', AP)
    await supertest(server).get('/servers/x').set('Accept', AP)
    expect(builds['/servers/x']).toBe(2)
  })

  it('keeps an entry no longer than its max-age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const server = app()
    await supertest(server).get('/users/alice/featured').set('Accept', AP)
    await supertest(server).get('/users/alice/featured').set('Accept', AP)
    expect(builds['/users/alice/featured']).toBe(1)
    vi.setSystemTime(Date.now() + 1500)
    await supertest(server).get('/users/alice/featured').set('Accept', AP)
    expect(builds['/users/alice/featured']).toBe(2)
  })

  it('keeps an entry no longer than its own limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const server = app()
    await supertest(server).get('/users/alice').set('Accept', AP)
    vi.setSystemTime(Date.now() + 29_000)
    await supertest(server).get('/users/alice').set('Accept', AP)
    expect(builds['/users/alice']).toBe(1)
    vi.setSystemTime(Date.now() + 2_000)
    await supertest(server).get('/users/alice').set('Accept', AP)
    expect(builds['/users/alice']).toBe(2)
  })

  it('drops a path and the paths below it, here and in other processes', async () => {
    const server = app()
    for (const p of ['/users/alice', '/users/alice/featured', '/users/alice2', `/posts/${POST}`]) {
      await supertest(server).get(p).set('Accept', AP)
    }
    await invalidateDocuments(['/users/alice'])
    for (const p of ['/users/alice', '/users/alice/featured', '/users/alice2', `/posts/${POST}`]) {
      await supertest(server).get(p).set('Accept', AP)
    }
    expect(builds).toEqual({ '/users/alice': 2, '/users/alice/featured': 2, '/users/alice2': 1, [`/posts/${POST}`]: 1 })
    expect(published).toEqual([['doc-cache:invalidate', JSON.stringify(['/users/alice'])]])
  })

  it('applies invalidations another process publishes', async () => {
    await subscribeDocumentInvalidation()
    const server = app()
    await supertest(server).get(`/posts/${POST}`).set('Accept', AP)
    subscriber.emit('message', 'doc-cache:invalidate', JSON.stringify(postDocumentPaths(POST, 'alice')))
    subscriber.emit('message', 'doc-cache:invalidate', 'not json')
    await supertest(server).get(`/posts/${POST}`).set('Accept', AP)
    expect(builds[`/posts/${POST}`]).toBe(2)
  })

  it('holds at most 32 MiB of documents, the least recently used going first', async () => {
    const server = app()
    for (let page = 1; page <= 40; page++) await supertest(server).get(`/users/alice/outbox?page=${page}`).set('Accept', AP)
    const { entries, bytes } = documentCacheSize()
    expect(bytes).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(entries).toBeLessThan(40)
    await supertest(server).get('/users/alice/outbox?page=40').set('Accept', AP)
    await supertest(server).get('/users/alice/outbox?page=1').set('Accept', AP)
    expect(builds['/users/alice/outbox']).toBe(41)
  })

  it('does not keep a build that started before its path was invalidated', async () => {
    let open!: () => void
    gate = new Promise((r) => { open = r })
    const server = app()
    const pending = supertest(server).get('/users/alice').set('Accept', AP).then((r) => r)
    await new Promise((r) => setTimeout(r, 30))
    await invalidateDocuments(['/users/alice'])
    open()
    expect((await pending).status).toBe(200)
    gate = null
    const next = await supertest(server).get('/users/alice').set('Accept', AP)
    expect(next.headers['x-harmony-cache']).toBe('miss')
    expect(builds['/users/alice']).toBe(2)
  })

  it('answers 304 to a hit whose ETag the client holds', async () => {
    const server = app()
    const first = await supertest(server).get('/users/alice').set('Accept', AP)
    expect(first.headers.etag).toBeTruthy()
    const again = await supertest(server).get('/users/alice').set('Accept', AP).set('If-None-Match', first.headers.etag)
    expect(again.status).toBe(304)
    expect(again.headers['x-harmony-cache']).toBe('hit')
    expect(builds['/users/alice']).toBe(1)
  })

  it('names the documents of a post and of an account', () => {
    expect(postDocumentPaths(POST, 'alice')).toEqual([`/posts/${POST}`, '/@alice', '/users/alice'])
    expect(postDocumentPaths(POST, null)).toEqual([`/posts/${POST}`])
    expect(accountDocumentPaths('alice')).toEqual(['/users/alice', '/@alice', '/.well-known/webfinger'])
  })
})
