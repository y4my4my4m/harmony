import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /@:username, /@:username/:postId and /posts/:postId (publicPages/routes.ts).
// public_profile_page and public_post_page are emulated; their SQL is covered by
// db_schema/tests/188_public_profile_pages.sql.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    SUPABASE_URL: 'https://db.harmony.test',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  publicPageLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../utils/emojiResolvers.js', () => ({
  resolveLocalProfileEmojis: vi.fn(async () => {}),
}))

const rpc = vi.fn()
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc: (name: string, args: unknown) => rpc(name, args) }),
}))

const { default: publicPagesRouter } = await import('../publicPages/routes.js')

const POST_ID = '0b0e0000-0000-4000-8000-000000000001'
const INSTANCE = { enabled: true, name: 'Harmony Test', icon: null, registrations_open: true }

const alice = {
  id: 'a11ce000-0000-4000-8000-000000000001',
  username: 'alice',
  display_name: 'Alice',
  avatar_url: null,
  domain: null,
  is_local: true,
  discoverable: true,
  display_name_emojis: [],
}

function profilePage(over: Record<string, unknown> = {}, account: Record<string, unknown> = {}) {
  return {
    enabled: true,
    instance: INSTANCE,
    account: { ...alice, bio: 'Hi', profile_fields: [], followers_count: 2, following_count: 3, posts_count: 4, created_at: '2026-01-02T00:00:00Z', ...account },
    pinned: [],
    posts: [post()],
    next: null,
    ...over,
  }
}

function post(over: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    created_at: '2026-10-01T12:00:00Z',
    content: [{ type: 'text', text: 'hello world' }],
    content_warning: null,
    visibility: 'public',
    is_local: true,
    is_sensitive: false,
    media_attachments: [],
    replies_count: 0,
    reblogs_count: 0,
    favorites_count: 0,
    author: alice,
    ...over,
  }
}

function postPage(over: Record<string, unknown> = {}, postOver: Record<string, unknown> = {}) {
  return { enabled: true, instance: INSTANCE, post: post(postOver), ...over }
}

let answer: { data: unknown; error: unknown } = { data: null, error: null }

function app() {
  const a = express()
  a.use('/', publicPagesRouter)
  // Stands in for ActorService and OutboxHandler, which answer ActivityPub at these URLs.
  a.use((_req, res) => res.status(299).json({ passedOn: true }))
  return a
}

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
const DISCORDBOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const get = (path: string, ua = FIREFOX) => supertest(app()).get(path).set('User-Agent', ua)

beforeEach(() => {
  rpc.mockReset()
  rpc.mockImplementation(async () => answer)
})

describe('ActivityPub requests', () => {
  it.each([
    ['/@alice', 'application/activity+json'],
    [`/@alice/${POST_ID}`, 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'],
    [`/posts/${POST_ID}`, 'application/activity+json, text/html;q=0.1'],
  ])('%s with Accept %s passes on without a read', async (path, accept) => {
    const res = await get(path).set('Accept', accept)
    expect(res.status).toBe(299)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('GET /@:username', () => {
  it('renders the profile, cacheable, indexable, with the security headers', async () => {
    answer = { data: profilePage(), error: null }
    const res = await get('/@alice')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=60')
    expect(res.headers.vary).toBe('Accept, Accept-Language, User-Agent, Cookie')
    expect(res.headers['x-robots-tag']).toBeUndefined()
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'")
    expect(res.headers['content-security-policy']).toContain('img-src \'self\' data: https:')
    expect(res.text).toContain('data-testid="public-profile"')
    expect(res.text).toContain('hello world')
    expect(res.text).not.toContain('name="robots"')
    expect(rpc).toHaveBeenCalledWith('public_profile_page', { p_username: 'alice', p_before: null, p_limit: 20 })
  })

  it('passes a well-formed before cursor and marks later pages noindex', async () => {
    answer = { data: profilePage(), error: null }
    const res = await get(`/@alice?before=${POST_ID.toUpperCase()}`)
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('public_profile_page', { p_username: 'alice', p_before: POST_ID, p_limit: 20 })
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
  })

  it('ignores a malformed before cursor', async () => {
    answer = { data: profilePage(), error: null }
    await get('/@alice?before=1;drop')
    expect(rpc).toHaveBeenCalledWith('public_profile_page', { p_username: 'alice', p_before: null, p_limit: 20 })
  })

  it('marks an account that is not discoverable noindex', async () => {
    answer = { data: profilePage({}, { discoverable: false }), error: null }
    const res = await get('/@alice')
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('<meta name="robots" content="noindex, noarchive">')
  })

  it('marks a moved account noindex', async () => {
    answer = { data: profilePage({}, { moved_to_uri: 'https://elsewhere.example/users/alice' }), error: null }
    const res = await get('/@alice')
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('data-testid="public-moved"')
  })

  it('moves a username spelled in another case to its spelling, 301, cursor kept', async () => {
    answer = { data: profilePage(), error: null }
    const res = await get(`/@ALICE?before=${POST_ID}`)
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`/@alice?before=${POST_ID}`)
  })

  it('sends a remote handle to the app', async () => {
    const res = await get('/@bob@remote.example')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/social/profile/bob@remote.example')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers a malformed username 404 without a read', async () => {
    const res = await get('/@bad%20name')
    expect(res.status).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('data-status="not_found"')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers an unknown or hidden account 404, handing a signed-in reader to the app', async () => {
    answer = { data: { enabled: true, instance: INSTANCE, account: null }, error: null }
    const res = await get('/@ghost')
    expect(res.status).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('data-status="not_found"')
    expect(res.text).toContain('"/social/profile/ghost"')
  })

  it('sends visitors to sign in while the pages are off', async () => {
    answer = { data: profilePage({ enabled: false }), error: null }
    const res = await get('/@alice?before=' + POST_ID)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`/login?redirect=${encodeURIComponent(`/@alice?before=${POST_ID}`)}`)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toContain('Cookie')
  })

  it('still serves a link-preview crawler while the pages are off, noindex', async () => {
    answer = { data: profilePage({ enabled: false }), error: null }
    const res = await get('/@alice', DISCORDBOT)
    expect(res.status).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('<meta name="robots" content="noindex, noarchive">')
    expect(res.text).toContain('<meta property="og:title" content="Alice (@alice@harmony.test)">')
  })

  it('answers 503 when the read fails', async () => {
    answer = { data: null, error: { message: 'boom' } }
    const res = await get('/@alice')
    expect(res.status).toBe(503)
    expect(res.headers['retry-after']).toBe('30')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.text).toContain('data-status="unavailable"')
  })

  it('writes the page in the reader\'s language', async () => {
    answer = { data: profilePage(), error: null }
    const res = await get('/@alice').set('Accept-Language', 'fr-CA,fr;q=0.9,en;q=0.5')
    expect(res.text).toContain('<html lang="fr">')
  })
})

describe('GET /@:username/:postId', () => {
  it('renders the post, indexable', async () => {
    answer = { data: postPage(), error: null }
    const res = await get(`/@alice/${POST_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers['x-robots-tag']).toBeUndefined()
    expect(res.text).toContain(`<link rel="canonical" href="https://harmony.test/@alice/${POST_ID}">`)
    expect(res.text).toContain('hello world')
    expect(rpc).toHaveBeenCalledWith('public_post_page', { p_post_id: POST_ID })
  })

  it('marks an unlisted post noindex', async () => {
    answer = { data: postPage({}, { visibility: 'unlisted' }), error: null }
    const res = await get(`/@alice/${POST_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('<meta name="robots" content="noindex, noarchive">')
  })

  it('marks a post of an account that is not discoverable noindex', async () => {
    answer = { data: postPage({}, { author: { ...alice, discoverable: false } }), error: null }
    const res = await get(`/@alice/${POST_ID}`)
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
  })

  it('moves the username of the URL to the author\'s spelling', async () => {
    answer = { data: postPage(), error: null }
    const res = await get(`/@Alice/${POST_ID}`)
    expect(res.status).toBe(301)
    expect(res.headers.location).toBe(`/@alice/${POST_ID}`)
  })

  it('does not find a post under another account', async () => {
    answer = { data: postPage(), error: null }
    const res = await get(`/@mallory/${POST_ID}`)
    expect(res.status).toBe(404)
    expect(res.text).toContain(`"/social/post/${POST_ID}"`)
  })

  it('does not find a remote post under a local address', async () => {
    const remote = { ...alice, is_local: false, domain: 'remote.example' }
    answer = { data: postPage({}, { is_local: false, author: remote }), error: null }
    const res = await get(`/@alice/${POST_ID}`)
    expect(res.status).toBe(404)
  })

  it('answers a malformed post id 404 without a read', async () => {
    const res = await get('/@alice/not-a-uuid')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers a hidden post 404, handing a signed-in reader to the app', async () => {
    answer = { data: { enabled: true, instance: INSTANCE, post: null }, error: null }
    const res = await get(`/@alice/${POST_ID}`)
    expect(res.status).toBe(404)
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain(`"/social/post/${POST_ID}"`)
  })

  it('sends visitors to sign in while the pages are off, crawlers excepted', async () => {
    answer = { data: postPage({ enabled: false }), error: null }
    const visitor = await get(`/@alice/${POST_ID}`)
    expect(visitor.status).toBe(302)
    expect(visitor.headers.location).toBe(`/login?redirect=${encodeURIComponent(`/@alice/${POST_ID}`)}`)
    const crawler = await get(`/@alice/${POST_ID}`, DISCORDBOT)
    expect(crawler.status).toBe(200)
    expect(crawler.headers['x-robots-tag']).toBe('noindex, noarchive')
  })
})

describe('GET /posts/:postId', () => {
  it('renders a local post with the /@ page as canonical, indexable', async () => {
    answer = { data: postPage(), error: null }
    const res = await get(`/posts/${POST_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers['x-robots-tag']).toBeUndefined()
    expect(res.text).toContain(`<link rel="canonical" href="https://harmony.test/@alice/${POST_ID}">`)
  })

  it('renders a remote post noindex, canonical at its origin', async () => {
    const remote = { ...alice, username: 'bob', is_local: false, domain: 'remote.example', url: 'https://remote.example/@bob' }
    answer = { data: postPage({}, { is_local: false, author: remote, url: 'https://remote.example/@bob/1' }), error: null }
    const res = await get(`/posts/${POST_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex, noarchive')
    expect(res.text).toContain('<link rel="canonical" href="https://remote.example/@bob/1">')
  })

  it('answers a malformed id 404 without a read', async () => {
    const res = await get('/posts/12345')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sends visitors to sign in while the pages are off', async () => {
    answer = { data: postPage({ enabled: false }), error: null }
    const res = await get(`/posts/${POST_ID}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`/login?redirect=${encodeURIComponent(`/posts/${POST_ID}`)}`)
  })
})
