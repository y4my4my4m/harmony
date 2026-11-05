import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// The public funding feed, the project feed a self-hosted instance reads and caches, the
// re-validation that keeps a hostile feed's markup, links and text out, and the project fund's
// links, which are constants whatever a feed or database holds.

const cfg = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'self.example',
  NODE_ENV: 'test',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const rpc = vi.hoisted(() => vi.fn())
// instance_funding reads: from(table).select(columns).limit(n).maybeSingle().
const from = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ rpc, from }) }))

function fundingRow(result: { data: unknown; error: unknown }) {
  const select = vi.fn(() => ({ limit: () => ({ maybeSingle: async () => result }) }))
  from.mockReturnValue({ select })
  return select
}

const {
  sanitizeFeed, buildFeed, isProjectInstance, ProjectFundingCache, PROJECT_FUNDING_FALLBACK,
  FRESH_MS, STALE_MS, RETRY_MS, readShowProjectMessages, PROJECT_DOMAIN, PROJECT_FEED_URL,
  PROJECT_LINKS, PROJECT_PAYMENT_LINK_IDS, projectFeedUrl, setTestProject,
} = await import('../services/projectFunding.js')
const { textProblem } = await import('../services/supporterMessageText.js')
const { createFundingRouter } = await import('../routes/funding.js')

const GOOD = {
  version: 1,
  instance: 'har.mony.lol',
  enabled: true,
  goal: { amount: 2000, currency: 'USD', period: 'monthly', raised: 120, periodEnd: '2026-12-01T00:00:00.000Z', description: 'Servers and development' },
  supporters: 8,
  links: [
    { platform: 'stripe', url: 'https://buy.stripe.com/abc', label: 'One-time' },
    { platform: 'ko-fi', url: 'https://ko-fi.com/harmony', label: '' },
  ],
  messages: [
    { id: '0b6f8a1e-0000-4000-8000-000000000001', body: 'Thanks for Harmony!', name: 'Alice', at: '2026-11-04T10:00:00.000Z' },
    { id: '0b6f8a1e-0000-4000-8000-000000000002', body: 'Keep going', name: null, at: '2026-11-03T10:00:00.000Z' },
  ],
}

describe('textProblem', () => {
  it('applies the rules of public.supporter_message_problem', () => {
    expect(textProblem('Thanks for Harmony!')).toBeNull()
    expect(textProblem('<img src=x onerror=alert(1)>')).toBeNull()
    expect(textProblem('a'.repeat(50))).toBeNull()
    expect(textProblem('a'.repeat(51))).toBe('length')
    expect(textProblem('\u{1F600}'.repeat(50))).toBeNull()
    expect(textProblem('')).toBe('empty')
    expect(textProblem(' x')).toBe('whitespace')
    expect(textProblem('e\u0301')).toBe('normalization')
    expect(textProblem('a\nb')).toBe('control')
    expect(textProblem('a\u0085b')).toBe('control')
    expect(textProblem('a\u2028b')).toBe('control')
    expect(textProblem('\u202egnp.exe')).toBe('bidi')
    expect(textProblem('a\u2066b\u2069')).toBe('bidi')
    expect(textProblem('a\u200fb')).toBe('bidi')
    expect(textProblem('Z\u0351\u0353\u036b'.normalize('NFC'))).toBe('marks')
    expect(textProblem('a\u0331\u0332 b')).toBeNull()
    expect(textProblem(42)).toBe('type')
  })
})

describe('sanitizeFeed', () => {
  it('keeps a well-formed feed as it is', () => {
    expect(sanitizeFeed(GOOD)).toEqual({ ...GOOD, goal: { ...GOOD.goal } })
  })

  it('drops what a hostile feed slips in', () => {
    const hostile = {
      ...GOOD,
      instance: 'har.mony.lol',
      links: [
        { platform: 'stripe', url: 'javascript:alert(1)', label: 'Pay' },
        { platform: 'custom', url: 'data:text/html,<script>alert(1)</script>', label: 'x' },
        { platform: 'custom', url: 'http://plain.example/pay', label: 'x' },
        { platform: 'custom', url: 'https://user:pw@evil.example/', label: 'x' },
        { platform: '<b>evil</b>', url: 'https://ok.example/pay', label: '\u202eyap' },
        'https://bare.example',
        { platform: 'ko-fi', url: 'https://ko-fi.com/harmony', label: 'Ko-fi' },
      ],
      messages: [
        { id: '1', body: '<img src=x onerror=alert(1)>', name: '<b>Mallory</b>', at: '2026-11-04T10:00:00Z' },
        { id: '2', body: 'line\nbreak', name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '3', body: '\u202eevil', name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '4', body: 'Z\u0351\u0353\u036b\u0354', name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '5', body: 'x'.repeat(51), name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '6', body: 'fine', name: 'A\u202e', at: '2026-11-04T10:00:00Z' },
        { id: '7', body: { html: '<script>' }, name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '8', body: 'fine', name: 'A', at: 'not a date' },
        { id: '<script>', body: 'fine', name: 'A', at: '2026-11-04T10:00:00Z' },
        { id: '9', body: 'kept', name: null, at: '2026-11-04T10:00:00Z', user_id: 'leak', html: '<i>' },
      ],
      goal: { amount: 'lots', currency: 'USD', period: 'monthly', raised: 1 },
      supporters: -5,
      extra: '<script>alert(1)</script>',
    }
    const feed = sanitizeFeed(hostile)!
    expect(feed.links).toEqual([
      { platform: 'custom', url: 'https://ok.example/pay', label: '' },
      { platform: 'ko-fi', url: 'https://ko-fi.com/harmony', label: 'Ko-fi' },
    ])
    // Markup is text: kept as written, rendered by the client as text.
    expect(feed.messages).toEqual([
      { id: '1', body: '<img src=x onerror=alert(1)>', name: '<b>Mallory</b>', at: '2026-11-04T10:00:00.000Z' },
      { id: '9', body: 'kept', name: null, at: '2026-11-04T10:00:00.000Z' },
    ])
    expect(feed.goal).toBeNull()
    expect(feed.supporters).toBe(0)
    expect(feed).not.toHaveProperty('extra')
  })

  it('caps links and messages, and refuses what is not a feed', () => {
    const many = sanitizeFeed({
      ...GOOD,
      links: Array.from({ length: 50 }, (_, i) => ({ platform: 'custom', url: `https://l${i}.example/`, label: '' })),
      messages: Array.from({ length: 50 }, (_, i) => ({ id: String(i), body: `m${i}`, name: null, at: '2026-11-04T10:00:00Z' })),
    })!
    expect(many.links).toHaveLength(8)
    expect(many.messages).toHaveLength(12)
    expect(sanitizeFeed(null)).toBeNull()
    expect(sanitizeFeed([GOOD])).toBeNull()
    expect(sanitizeFeed({ ...GOOD, version: 2 })).toBeNull()
    expect(sanitizeFeed({ ...GOOD, instance: 'evil host/<x>' })).toBeNull()
    expect(sanitizeFeed({ ...GOOD, enabled: false })).toMatchObject({ enabled: false, links: [], messages: [], goal: null })
  })
})

describe('buildFeed', () => {
  const summary = {
    enabled: true,
    goal_amount: 2000,
    goal_currency: 'USD',
    funding_period: 'monthly',
    goal_description: 'Servers',
    funding_links: [{ platform: 'stripe', url: 'https://buy.stripe.com/abc', label: 'One-time' }],
    displayed_amount: '120.50',
    period_end: '2026-12-01T00:00:00+00:00',
    supporter_count: 8,
    supporter_messages_enabled: true,
    supporter_messages_public: true,
    messages: [
      { id: 'a1', body: 'Named', anonymous: false, name: 'Alice', at: '2026-11-04T10:00:00+00:00', user_id: 'u1', avatar_url: 'https://x/a.png' },
      { id: 'a2', body: 'Hidden name', anonymous: true, name: null, at: '2026-11-03T10:00:00+00:00', user_id: null, avatar_url: null },
    ],
  }

  it('publishes goal, links and approved messages, without profile ids or avatars', () => {
    const feed = buildFeed(summary as any, 'har.mony.lol')
    expect(feed).toEqual({
      version: 1,
      instance: 'har.mony.lol',
      enabled: true,
      goal: { amount: 2000, currency: 'USD', period: 'monthly', raised: 120.5, periodEnd: '2026-12-01T00:00:00.000Z', description: 'Servers' },
      supporters: 8,
      links: [{ platform: 'stripe', url: 'https://buy.stripe.com/abc', label: 'One-time' }],
      messages: [
        { id: 'a1', body: 'Named', name: 'Alice', at: '2026-11-04T10:00:00.000Z' },
        { id: 'a2', body: 'Hidden name', name: null, at: '2026-11-03T10:00:00.000Z' },
      ],
    })
    expect(JSON.stringify(feed)).not.toMatch(/u1|avatar/)
  })

  it('publishes no messages when their public display is off, and nothing when funding is off', () => {
    expect(buildFeed({ ...summary, supporter_messages_public: false } as any, 'x').messages).toEqual([])
    expect(buildFeed({ ...summary, enabled: false } as any, 'x')).toEqual({
      version: 1, instance: 'x', enabled: false, goal: null, supporters: 0, links: [], messages: [],
    })
    expect(buildFeed(null, 'x').enabled).toBe(false)
  })
})

describe('the project fund\'s constants', () => {
  it('are the Harmony development fund\'s Payment Links and Ko-fi on har.mony.lol', () => {
    expect(PROJECT_DOMAIN).toBe('har.mony.lol')
    expect(PROJECT_FEED_URL).toBe('https://har.mony.lol/api/federation/funding/project-feed')
    expect(PROJECT_LINKS).toEqual([
      { platform: 'stripe', url: 'https://donate.stripe.com/fZu8wQ29W5S97hrcqKb7y03', label: 'One-time' },
      { platform: 'stripe', url: 'https://donate.stripe.com/8x25kEbKwbct59jcqKb7y04', label: 'Monthly' },
      { platform: 'ko-fi', url: 'https://ko-fi.com/y4my4my4m', label: 'Ko-fi' },
    ])
    expect([...PROJECT_PAYMENT_LINK_IDS]).toEqual(['plink_1UYKJgIByukKkdhljBcFnf5I', 'plink_1UYKRBIByukKkdhlRV8itB6j'])
    expect(Object.isFrozen(PROJECT_LINKS) && PROJECT_LINKS.every((l) => Object.isFrozen(l))).toBe(true)
    expect(PROJECT_FUNDING_FALLBACK.links).toEqual(PROJECT_LINKS)
    expect(sanitizeFeed(PROJECT_FUNDING_FALLBACK)).toEqual(PROJECT_FUNDING_FALLBACK)
  })
})

describe('isProjectInstance', () => {
  it('is INSTANCE_DOMAIN being har.mony.lol, whatever else the configuration holds', () => {
    expect(isProjectInstance('har.mony.lol')).toBe(true)
    expect(isProjectInstance('HAR.MONY.LOL')).toBe(true)
    expect(isProjectInstance('self.example')).toBe(false)
    expect(isProjectInstance('har.mony.lol.self.example')).toBe(false)
    expect(isProjectInstance()).toBe(false)
    Object.assign(cfg, { PROJECT_INSTANCE: 'true', PROJECT_FUNDING_URL: 'https://self.example/api/federation/funding/project-feed' })
    try {
      expect(isProjectInstance()).toBe(false)
      expect(projectFeedUrl()).toBe(PROJECT_FEED_URL)
    } finally {
      delete (cfg as Record<string, unknown>).PROJECT_INSTANCE
      delete (cfg as Record<string, unknown>).PROJECT_FUNDING_URL
    }
  })

  it('takes a journey\'s stand-in outside production only', () => {
    try {
      setTestProject({ projectInstance: true, feedUrl: 'http://192.0.2.1:9/api/federation/funding/project-feed' })
      expect(isProjectInstance()).toBe(true)
      expect(projectFeedUrl()).toBe('http://192.0.2.1:9/api/federation/funding/project-feed')
    } finally {
      setTestProject(null)
    }
    expect(isProjectInstance()).toBe(false)
    expect(() => setTestProject({ projectInstance: true }, 'production')).toThrow(/production/)
    expect(isProjectInstance()).toBe(false)
  })
})

describe('ProjectFundingCache', () => {
  let now: number
  beforeEach(() => { now = Date.parse('2026-11-05T00:00:00Z') })

  it('reads once per FRESH_MS, sharing a read in progress', async () => {
    const fetcher = vi.fn(async () => GOOD)
    const cache = new ProjectFundingCache('https://har.mony.lol/f', fetcher, () => now)
    const [a, b] = await Promise.all([cache.get(), cache.get()])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(a.source).toBe('upstream')
    expect(b.funding.messages).toHaveLength(2)
    now += FRESH_MS - 1
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 2
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('serves the last copy while the project is unreachable, then the fallback', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(GOOD).mockRejectedValue(new Error('ECONNREFUSED'))
    const cache = new ProjectFundingCache('https://har.mony.lol/f', fetcher, () => now)
    await cache.get()
    now += FRESH_MS + 1
    const stale = await cache.get()
    expect(stale.source).toBe('stale')
    expect(stale.funding.instance).toBe('har.mony.lol')
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Within RETRY_MS of a failure nothing is fetched.
    now += RETRY_MS - 1
    await cache.get()
    expect(fetcher).toHaveBeenCalledTimes(2)
    now += STALE_MS
    const gone = await cache.get()
    expect(gone.source).toBe('fallback')
    expect(gone.funding).toEqual(PROJECT_FUNDING_FALLBACK)
  })

  it('reads PROJECT_FEED_URL by default', async () => {
    const fetcher = vi.fn(async () => GOOD)
    await new ProjectFundingCache(undefined, fetcher, () => now).get()
    expect(fetcher).toHaveBeenCalledWith(PROJECT_FEED_URL)
  })

  it('falls back when the first read fails or returns no feed', async () => {
    const bad = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => '<html>'), () => now)
    expect((await bad.get()).source).toBe('fallback')
    const down = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => { throw new Error('timeout') }), () => now)
    expect(await down.get()).toEqual({ source: 'fallback', fetchedAt: null, funding: PROJECT_FUNDING_FALLBACK })
  })
})

describe('funding routes', () => {
  it('GET /public answers JSON any origin may read, read from the database once a minute', async () => {
    let now = 0
    const readFeed = vi.fn(async () => sanitizeFeed(GOOD)!)
    const app = express()
    app.use('/funding', createFundingRouter({ readFeed, now: () => now }))
    const res = await supertest(app).get('/funding/public').set('Origin', 'https://mony.lol')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.body.messages[0].body).toBe('Thanks for Harmony!')
    await supertest(app).get('/funding/public')
    expect(readFeed).toHaveBeenCalledTimes(1)
    now += 60_001
    await supertest(app).get('/funding/public')
    expect(readFeed).toHaveBeenCalledTimes(2)
  })

  it('GET /public reads the summary as service_role', async () => {
    rpc.mockResolvedValueOnce({ data: { enabled: false }, error: null })
    const app = express()
    app.use('/funding', createFundingRouter())
    const res = await supertest(app).get('/funding/public')
    expect(rpc).toHaveBeenCalledWith('get_funding_summary')
    expect(res.body).toEqual({ version: 1, instance: 'self.example', enabled: false, goal: null, supporters: 0, links: [], messages: [] })
  })

  it('GET /project names the project instance, else serves the cached project feed', async () => {
    const project = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => GOOD))
    const self = express()
    self.use('/funding', createFundingRouter({ project, projectInstance: () => false, showProjectMessages: async () => true }))
    const res = await supertest(self).get('/funding/project')
    expect(res.body).toMatchObject({ projectInstance: false, source: 'upstream', funding: { instance: 'har.mony.lol' } })

    const fetcher = vi.fn()
    const shown = vi.fn(async () => false)
    const local = vi.fn(async () => sanitizeFeed({ ...GOOD, supporters: 3 })!)
    const own = express()
    own.use('/funding', createFundingRouter({
      project: new ProjectFundingCache('x', fetcher), projectInstance: () => true, showProjectMessages: shown, readProjectFeed: local,
    }))
    const mine = await supertest(own).get('/funding/project')
    expect(mine.body).toMatchObject({ projectInstance: true, source: 'local', funding: { supporters: 3, links: PROJECT_LINKS } })
    expect(mine.body.funding.messages).toHaveLength(2)
    expect(Date.parse(mine.body.fetchedAt)).not.toBeNaN()
    expect(fetcher).not.toHaveBeenCalled()
    expect(shown).not.toHaveBeenCalled()
  })

  it('GET /project on the project instance keeps its read a minute; ?fresh=1 reads again', async () => {
    let now = 0
    let supporters = 1
    const local = vi.fn(async () => sanitizeFeed({ ...GOOD, supporters })!)
    const own = express()
    own.use('/funding', createFundingRouter({ projectInstance: () => true, readProjectFeed: local, now: () => now }))
    expect((await supertest(own).get('/funding/project')).body.funding.supporters).toBe(1)
    supporters = 2
    now = 10_000
    expect((await supertest(own).get('/funding/project')).body.funding.supporters).toBe(1)
    expect((await supertest(own).get('/funding/project?fresh=1')).body.funding.supporters).toBe(2)
    expect(local).toHaveBeenCalledTimes(2)
  })

  it('GET /project on the project instance serves the standing links when its fund cannot be read', async () => {
    const own = express()
    own.use('/funding', createFundingRouter({
      projectInstance: () => true, readProjectFeed: async () => { throw new Error('connection refused') },
    }))
    const res = await supertest(own).get('/funding/project')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projectInstance: true, source: 'fallback', fetchedAt: null, funding: PROJECT_FUNDING_FALLBACK })
  })

  it('GET /project-feed is served by the project instance only, any origin, once a minute', async () => {
    let now = 0
    const readProjectFeed = vi.fn(async () => sanitizeFeed(GOOD)!)
    const own = express()
    own.use('/funding', createFundingRouter({ projectInstance: () => true, readProjectFeed, now: () => now }))
    const res = await supertest(own).get('/funding/project-feed').set('Origin', 'https://self.example')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(sanitizeFeed(res.body)).toEqual({ ...sanitizeFeed(GOOD), links: PROJECT_LINKS })
    await supertest(own).get('/funding/project-feed')
    expect(readProjectFeed).toHaveBeenCalledTimes(1)
    now += 60_001
    await supertest(own).get('/funding/project-feed')
    expect(readProjectFeed).toHaveBeenCalledTimes(2)

    const elsewhere = vi.fn(async () => sanitizeFeed(GOOD)!)
    const self = express()
    self.use('/funding', createFundingRouter({ projectInstance: () => false, readProjectFeed: elsewhere }))
    const missing = await supertest(self).get('/funding/project-feed')
    expect(missing.status).toBe(404)
    expect(missing.headers['content-type']).toMatch(/^application\/json/)
    expect(elsewhere).not.toHaveBeenCalled()
  })

  it('the instance feed and the project fund feed keep their funds apart', async () => {
    const instanceSummary = {
      enabled: true, goal_amount: 100, goal_currency: 'USD', funding_period: 'monthly',
      goal_description: 'Server costs', displayed_amount: 25, period_end: '2026-12-01T00:00:00Z', supporter_count: 2,
      funding_links: [{ platform: 'stripe', url: 'https://buy.stripe.com/server', label: '' }],
      supporter_messages_enabled: true, supporter_messages_public: true,
      messages: [{ id: '0b6f8a1e-0000-4000-8000-0000000000c1', body: 'For the server', anonymous: false, name: 'Bo', at: '2026-11-04T10:00:00Z' }],
    }
    const projectSummary = {
      enabled: true, goal_amount: 2000, goal_currency: 'USD', funding_period: 'monthly',
      goal_description: 'Harmony development', displayed_amount: 640, period_end: '2026-12-01T00:00:00Z', supporter_count: 21,
      funding_links: [{ platform: 'stripe', url: 'https://buy.stripe.com/pocketed', label: 'One-time' }],
      supporter_messages_enabled: true, supporter_messages_public: true,
      messages: [{ id: '0b6f8a1e-0000-4000-8000-0000000000d1', body: 'For Harmony', anonymous: true, name: 'Cy', at: '2026-11-04T11:00:00Z' }],
    }
    rpc.mockImplementation(async (fn: string) => ({
      data: fn === 'get_project_funding_summary' ? projectSummary : fn === 'get_funding_summary' ? instanceSummary : null,
      error: null,
    }))
    const app = express()
    app.use('/funding', createFundingRouter({ projectInstance: () => true }))
    const own = (await supertest(app).get('/funding/public')).body
    const fund = (await supertest(app).get('/funding/project-feed')).body
    const local = (await supertest(app).get('/funding/project')).body
    rpc.mockReset()

    expect(own).toMatchObject({ instance: 'self.example', supporters: 2, goal: { raised: 25, description: 'Server costs' } })
    expect(own.links.map((l: { url: string }) => l.url)).toEqual(['https://buy.stripe.com/server'])
    expect(own.messages.map((m: { body: string }) => m.body)).toEqual(['For the server'])
    expect(fund).toMatchObject({ instance: 'self.example', supporters: 21, goal: { raised: 640, description: 'Harmony development' } })
    expect(fund.links).toEqual(PROJECT_LINKS)
    expect(JSON.stringify(fund)).not.toContain('pocketed')
    expect(fund.messages).toEqual([{ id: '0b6f8a1e-0000-4000-8000-0000000000d1', body: 'For Harmony', name: null, at: '2026-11-04T11:00:00.000Z' }])
    expect(local.funding).toEqual(fund)
  })

  it('GET /project carries the project\'s links, never the feed\'s, fresh, stale or fallen back', async () => {
    let now = Date.parse('2026-11-05T00:00:00Z')
    const fetcher = vi.fn().mockResolvedValueOnce(GOOD).mockRejectedValue(new Error('ECONNREFUSED'))
    const project = new ProjectFundingCache('https://har.mony.lol/f', fetcher, () => now)
    const app = express()
    app.use('/funding', createFundingRouter({ project, projectInstance: () => false, showProjectMessages: async () => true }))
    const seen: string[] = []
    for (const step of [0, FRESH_MS + 1, STALE_MS]) {
      now += step
      const res = await supertest(app).get('/funding/project')
      seen.push(res.body.source)
      expect(res.body.funding.links).toEqual(PROJECT_LINKS)
      expect(res.text).not.toContain('buy.stripe.com/abc')
      expect(res.text).not.toContain('ko-fi.com/harmony')
    }
    expect(seen).toEqual(['upstream', 'stale', 'fallback'])
  })

  it('GET /project carries the project\'s messages only while show_project_messages is on', async () => {
    const project = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => GOOD))
    let shown = true
    const app = express()
    app.use('/funding', createFundingRouter({ project, projectInstance: () => false, showProjectMessages: async () => shown }))

    const on = await supertest(app).get('/funding/project')
    expect(on.body.funding.messages.map((m: { body: string }) => m.body)).toEqual(['Thanks for Harmony!', 'Keep going'])

    shown = false
    const off = await supertest(app).get('/funding/project')
    expect(off.body).toMatchObject({ projectInstance: false, source: 'upstream', funding: { instance: 'har.mony.lol', supporters: 8 } })
    expect(off.body.funding.messages).toEqual([])
    expect(off.body.funding.links).toEqual(PROJECT_LINKS)
    expect(off.body.funding.goal).toEqual(GOOD.goal)
    expect(off.text).not.toContain('Thanks for Harmony!')
    expect(off.text).not.toContain('Alice')

    shown = true
    const again = await supertest(app).get('/funding/project')
    expect(again.body.funding.messages).toHaveLength(2)
  })

  it('GET /project leaves the messages out when the switch cannot be read', async () => {
    const project = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => GOOD))
    const app = express()
    app.use('/funding', createFundingRouter({
      project, projectInstance: () => false, showProjectMessages: async () => { throw new Error('connection refused') },
    }))
    const res = await supertest(app).get('/funding/project')
    expect(res.status).toBe(200)
    expect(res.body.funding.links).toEqual(PROJECT_LINKS)
    expect(res.body.funding.messages).toEqual([])
  })

  it('GET /project reads the switch from instance_funding as service_role', async () => {
    const project = new ProjectFundingCache('https://har.mony.lol/f', vi.fn(async () => GOOD))
    const app = express()
    app.use('/funding', createFundingRouter({ project, projectInstance: () => false }))

    const select = fundingRow({ data: { show_project_messages: false }, error: null })
    expect((await supertest(app).get('/funding/project')).body.funding.messages).toEqual([])
    expect(from).toHaveBeenCalledWith('instance_funding')
    expect(select).toHaveBeenCalledWith('show_project_messages')

    fundingRow({ data: { show_project_messages: true }, error: null })
    expect((await supertest(app).get('/funding/project')).body.funding.messages).toHaveLength(2)
  })
})

describe('readShowProjectMessages', () => {
  it('is the column, on without a funding row, and throws on a read error', async () => {
    fundingRow({ data: { show_project_messages: false }, error: null })
    expect(await readShowProjectMessages()).toBe(false)
    fundingRow({ data: { show_project_messages: true }, error: null })
    expect(await readShowProjectMessages()).toBe(true)
    fundingRow({ data: null, error: null })
    expect(await readShowProjectMessages()).toBe(true)
    fundingRow({ data: null, error: { message: 'column instance_funding.show_project_messages does not exist' } })
    await expect(readShowProjectMessages()).rejects.toThrow(/does not exist/)
  })
})
