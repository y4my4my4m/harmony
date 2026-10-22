import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import dns from 'node:dns'

// GET /embed-media?u=: files of the relay's hosts only (video.twimg.com, Bluesky PDS blobs).
// By default a no-referrer redirect for every engine, never a stream; EMBED_RELAY_ENABLED=1
// streams X video to engines other than WebKit, =all streams everything (through safeFetch's
// address checks, ranges forwarded or cut here, size-capped). GET /embed-media/config says
// whether X video is streamed to the asking engine. GET /embed-media/instagram/...: a redirect to the current CDN URL
// of an Instagram media.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  NODE_ENV: 'test',
  EMBED_RELAY_MAX_BYTES: undefined as number | undefined,
  EMBED_RELAY_ENABLED: undefined as string | undefined,
}))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const actualSafeFetch = vi.hoisted(() => ({ fn: null as null | ((...args: any[]) => Promise<Response>) }))
const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/ssrfProtection.js')>()
  actualSafeFetch.fn = actual.safeFetch
  return { ...actual, safeFetch }
})

const instagramMediaTarget = vi.hoisted(() => vi.fn())
const isInstagramPostCached = vi.hoisted(() => vi.fn(() => true))
vi.mock('../services/socialEmbeds.js', () => ({ instagramMediaTarget, isInstagramPostCached }))

const take = vi.hoisted(() => vi.fn(async (_res: any, _key: string) => true))
vi.mock('../middleware/rateLimit.js', () => ({
  clientIp: () => '203.0.113.9',
  createStrictKeyedLimit: () => ({ take, tryTake: vi.fn(async () => true) }),
}))

const { default: router } = await import('../routes/embedMedia.js')
const app = express()
app.use('/embed-media', router)

const VIDEO = 'https://video.twimg.com/amplify_video/2112560648005484545/vid/avc1/720x1280/qnC_V3TZFNCfIUeO.mp4?tag=16'
const BLOB = 'https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Az72i7hdynmk6r22z27h6tvur&cid=bafkreiat76ppqns6bcnxnt6etzlyoar4o75v6wrzwjbh342oxbsebyun5e'
const PDS_BLOB = BLOB.replace('https://bsky.social/', 'https://puffball.us-east.host.bsky.network/')
const FILE = Buffer.from('0123456789')
const get = (u: string) => supertest(app).get(`/embed-media?u=${encodeURIComponent(u)}`)

function file(status: number, headers: Record<string, string>, body: BodyInit | null = FILE): Response {
  return new Response(body, { status, headers })
}

beforeEach(() => {
  safeFetch.mockReset()
  instagramMediaTarget.mockReset()
  isInstagramPostCached.mockReset()
  isInstagramPostCached.mockReturnValue(true)
  take.mockReset()
  take.mockResolvedValue(true)
  config.EMBED_RELAY_MAX_BYTES = undefined
  // The relay's own behaviour; the other modes have their own block below.
  config.EMBED_RELAY_ENABLED = 'all'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relay host list', () => {
  it.each([
    ['another host', 'https://example.com/a.mp4'],
    ['an X image host, loaded directly', 'https://pbs.twimg.com/media/HVFSyBvWAAE5Y1_.jpg'],
    ['the Instagram CDN, reached by redirect', 'https://scontent-nrt1-2.cdninstagram.com/o1/v/t2/f2/m86/a.mp4?oe=6ADBAA83'],
    ['plain http', 'http://video.twimg.com/x.mp4'],
    ['credentials', 'https://user:pw@video.twimg.com/x.mp4'],
    ['a port', 'https://video.twimg.com:8443/x.mp4'],
    ['a private address', 'https://10.0.0.1/x.mp4'],
    ['loopback', 'https://127.0.0.1/x.mp4'],
    ['a look-alike host', 'https://video.twimg.com.evil.example/x.mp4'],
    ['another XRPC method of a PDS', 'https://bsky.social/xrpc/com.atproto.server.createSession'],
    ['a blob with extra parameters', `${BLOB}&x=1`],
    ['a self-hosted PDS', BLOB.replace('https://bsky.social/', 'https://pds.self.example/')],
  ])('refuses %s without fetching', async (_name, url) => {
    const res = await get(url)
    expect(res.status).toBe(400)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('refuses a missing or oversized u', async () => {
    expect((await supertest(app).get('/embed-media')).status).toBe(400)
    expect((await get(`${VIDEO}&pad=${'a'.repeat(2100)}`)).status).toBe(400)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('refuses a relay host that resolves to a private address, through safeFetch', async () => {
    safeFetch.mockImplementation((...args: any[]) => actualSafeFetch.fn!(...args))
    vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['10.0.0.5'])
    vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await get(VIDEO)
    expect(res.status).toBe(502)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a redirect off the host list, and follows one on it', async () => {
    safeFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example/v.mp4' } }))
    expect((await get(VIDEO)).status).toBe(502)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(safeFetch.mock.calls[0][1].followRedirects).toBe(false)

    safeFetch.mockReset()
    safeFetch
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: PDS_BLOB } }))
      .mockResolvedValueOnce(file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const res = await get(BLOB)
    expect(res.status).toBe(200)
    expect(safeFetch.mock.calls.map(([u]) => u)).toEqual([BLOB, PDS_BLOB])
  })
})

describe('streaming', () => {
  it('passes a range through, without the reader\'s Referer or cookies', async () => {
    safeFetch.mockResolvedValue(file(206, {
      'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/6320063',
      'last-modified': 'Tue, 20 Oct 2026 15:02:42 GMT', 'set-cookie': 'a=b',
    }, FILE.subarray(0, 4)))
    const res = await get(VIDEO).set('Range', 'bytes=0-3').set('Referer', 'https://har.mony.lol/').set('Cookie', 'sb=1')
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe('bytes 0-3/6320063')
    expect(res.headers['content-length']).toBe('4')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['last-modified']).toBe('Tue, 20 Oct 2026 15:02:42 GMT')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.body.toString()).toBe('0123')
    const [url, init] = safeFetch.mock.calls[0]
    expect(url).toBe(VIDEO)
    expect(init.headers).toEqual({ 'User-Agent': expect.any(String), Accept: '*/*', 'Accept-Encoding': 'identity', Range: 'bytes=0-3' })
  })

  it('answers with headers that keep the file inert and loadable from any origin', async () => {
    safeFetch.mockResolvedValue(file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const res = await get(VIDEO)
    expect(res.status).toBe(200)
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('private, max-age=86400, no-transform')
    expect(res.body.toString()).toBe('0123456789')
  })

  it('cuts a whole-file answer (a PDS ignores Range) to the range asked', async () => {
    safeFetch.mockImplementation(async () => file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const middle = await get(BLOB).set('Range', 'bytes=2-5')
    expect(middle.status).toBe(206)
    expect(middle.headers['content-range']).toBe('bytes 2-5/10')
    expect(middle.headers['content-length']).toBe('4')
    expect(middle.body.toString()).toBe('2345')

    const tail = await get(BLOB).set('Range', 'bytes=7-')
    expect(tail.status).toBe(206)
    expect(tail.headers['content-range']).toBe('bytes 7-9/10')
    expect(tail.body.toString()).toBe('789')

    const past = await get(BLOB).set('Range', 'bytes=10-')
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe('bytes */10')
  })

  it('serves a file whole for a range it does not handle', async () => {
    safeFetch.mockResolvedValue(file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const res = await get(VIDEO).set('Range', 'bytes=0-1,4-5')
    expect(res.status).toBe(200)
    expect(safeFetch.mock.calls[0][1].headers.Range).toBeUndefined()
  })

  it('answers HEAD with the headers only', async () => {
    safeFetch.mockResolvedValue(file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const res = await supertest(app).head(`/embed-media?u=${encodeURIComponent(VIDEO)}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-length']).toBe('10')
    expect(res.body).toEqual({})
  })

  it.each([
    ['HTML', 'text/html; charset=utf-8'],
    ['SVG', 'image/svg+xml'],
    ['JavaScript', 'application/javascript'],
  ])('refuses %s', async (_name, type) => {
    safeFetch.mockResolvedValue(file(200, { 'content-type': type, 'content-length': '10' }))
    expect((await get(VIDEO)).status).toBe(502)
  })

  it('maps upstream refusals: 404 stays 404, others are 502', async () => {
    safeFetch.mockResolvedValueOnce(file(404, { 'content-type': 'text/plain' }, 'gone'))
    expect((await get(VIDEO)).status).toBe(404)
    safeFetch.mockResolvedValueOnce(file(403, { 'content-type': 'text/plain' }, 'no'))
    expect((await get(VIDEO)).status).toBe(502)
  })
})

describe('size cap', () => {
  beforeEach(() => {
    config.EMBED_RELAY_MAX_BYTES = 8
  })

  it('refuses a file whose length is over the cap', async () => {
    safeFetch.mockResolvedValue(file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    expect((await get(VIDEO)).status).toBe(413)
  })

  it('refuses a range of a file whose total is over the cap', async () => {
    safeFetch.mockResolvedValue(file(206, { 'content-type': 'video/mp4', 'content-length': '2', 'content-range': 'bytes 0-1/10' }, FILE.subarray(0, 2)))
    expect((await get(VIDEO).set('Range', 'bytes=0-1')).status).toBe(413)
  })

  it('cuts a stream of unknown length at the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(FILE.subarray(0, 6)))
        controller.enqueue(new Uint8Array(FILE.subarray(6, 10)))
        controller.close()
      },
    })
    safeFetch.mockResolvedValue(file(200, { 'content-type': 'video/mp4' }, stream))
    let received = ''
    try {
      const res = await get(VIDEO)
      received = res.body?.toString?.() ?? ''
    } catch {
      // The connection was cut.
    }
    expect(received.length).toBeLessThanOrEqual(8)
    expect(received).not.toBe('0123456789')
  })
})

describe('relay modes', () => {
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
  const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36'
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0'
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1'
  const MACOS_APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const STREAMED: Array<[string, Record<string, string>]> = [
    ['Chrome', { 'User-Agent': CHROME }],
    ['headless Chrome', { 'User-Agent': HEADLESS }],
    ['a Chromium client hint', { 'User-Agent': SAFARI, 'Sec-CH-UA': '"Chromium";v="155"' }],
    ['Firefox', { 'User-Agent': FIREFOX }],
    ['an unnamed engine', { 'User-Agent': '' }],
  ]
  const WEBKIT: Array<[string, Record<string, string>]> = [
    ['Safari', { 'User-Agent': SAFARI }],
    ['Chrome on iOS (WebKit)', { 'User-Agent': IOS_CHROME }],
    ['the macOS app (WKWebView)', { 'User-Agent': MACOS_APP }],
  ]

  const expectRedirect = (res: supertest.Response, to: string) => {
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(to)
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('private, max-age=86400')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers.vary).toMatch(/^User-Agent, Sec-CH-UA\b/)
  }
  const relaysXVideo = async (headers: Record<string, string>) =>
    (await supertest(app).get('/embed-media/config').set(headers)).body.relaysXVideo

  describe('unset: off', () => {
    beforeEach(() => {
      config.EMBED_RELAY_ENABLED = undefined
    })

    it.each([...STREAMED, ...WEBKIT])('redirects %s to the file and never streams', async (_name, headers) => {
      expectRedirect(await get(VIDEO).set(headers).set('Range', 'bytes=0-'), VIDEO)
      expectRedirect(await get(BLOB).set(headers).set('Range', 'bytes=2-5'), BLOB)
      expect(safeFetch).not.toHaveBeenCalled()
      expect(await relaysXVideo(headers)).toBe(false)
    })

    it('reads 0 and anything unknown as off', async () => {
      for (const value of ['0', 'false', 'yes please']) {
        config.EMBED_RELAY_ENABLED = value
        expectRedirect(await get(VIDEO).set('User-Agent', CHROME), VIDEO)
      }
      expect(safeFetch).not.toHaveBeenCalled()
    })

    it('redirects to the parsed URL, never to a form a browser resolves against this instance', async () => {
      const res = await get('https:video.twimg.com/../../../invite/abc').set('User-Agent', CHROME)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('https://video.twimg.com/invite/abc')
    })

    it('keeps the host list', async () => {
      expect((await get('https://example.com/a.mp4').set('User-Agent', FIREFOX)).status).toBe(400)
      expect((await get('https://10.0.0.1/x.mp4').set('User-Agent', FIREFOX)).status).toBe(400)
      expect((await get(`${BLOB}&x=1`).set('User-Agent', FIREFOX)).status).toBe(400)
    })
  })

  describe('1: X video for engines other than WebKit', () => {
    beforeEach(() => {
      config.EMBED_RELAY_ENABLED = '1'
      safeFetch.mockImplementation(async () => file(206, { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/10' }, FILE.subarray(0, 4)))
    })

    it.each(STREAMED)('streams X video to %s', async (_name, headers) => {
      const res = await get(VIDEO).set(headers).set('Range', 'bytes=0-3')
      expect(res.status).toBe(206)
      expect(res.body.toString()).toBe('0123')
      expect(await relaysXVideo(headers)).toBe(true)
    })

    it.each(WEBKIT)('redirects %s, which keeps the redirect for every range', async (_name, headers) => {
      expectRedirect(await get(VIDEO).set(headers), VIDEO)
      expect(safeFetch).not.toHaveBeenCalled()
      expect(await relaysXVideo(headers)).toBe(false)
    })

    it('redirects every engine to a Bluesky blob; nothing is cut to a range', async () => {
      for (const ua of [CHROME, FIREFOX, SAFARI]) {
        expectRedirect(await get(BLOB).set('User-Agent', ua).set('Range', 'bytes=2-5'), BLOB)
      }
      expect(safeFetch).not.toHaveBeenCalled()
    })
  })

  it('all: streams every engine, cutting a whole-file answer to the range', async () => {
    config.EMBED_RELAY_ENABLED = 'all'
    safeFetch.mockImplementation(async () => file(200, { 'content-type': 'video/mp4', 'content-length': '10' }))
    const res = await get(BLOB).set('User-Agent', SAFARI).set('Range', 'bytes=2-5')
    expect(res.status).toBe(206)
    expect(res.body.toString()).toBe('2345')
    expect(await relaysXVideo({ 'User-Agent': SAFARI })).toBe(true)
  })

  it('answers the config from any origin, by engine, briefly cached', async () => {
    config.EMBED_RELAY_ENABLED = undefined
    const res = await supertest(app).get('/embed-media/config').set('User-Agent', CHROME)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ relaysXVideo: false })
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
    expect(res.headers.vary).toMatch(/User-Agent, Sec-CH-UA/)
  })
})

describe('instagram redirects', () => {
  const CDN = 'https://scontent-nrt1-2.cdninstagram.com/o1/v/t2/f2/m86/a.mp4?oe=6ADBAA83'

  it('redirects to the current CDN URL, kept while it lives, without a Referer', async () => {
    instagramMediaTarget.mockResolvedValue({ url: CDN, expiresAt: Date.now() + 86_400_000 })
    const res = await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(CDN)
    expect(res.headers['cache-control']).toBe('private, max-age=3600')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(instagramMediaTarget).toHaveBeenCalledWith('DcCH2ZygIiP', '0')
  })

  it('names posters and the avatar by slot', async () => {
    instagramMediaTarget.mockResolvedValue({ url: CDN, expiresAt: Date.now() + 86_400_000 })
    await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/3/poster')
    await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/avatar')
    expect(instagramMediaTarget.mock.calls).toEqual([['DcCH2ZygIiP', '3/poster'], ['DcCH2ZygIiP', 'avatar']])
  })

  it('does not let the browser keep a redirect past the CDN URL', async () => {
    instagramMediaTarget.mockResolvedValue({ url: CDN, expiresAt: Date.now() + 5 * 60_000 })
    const res = await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers 404 for a post or slot that is not there, and for a target off the CDN', async () => {
    instagramMediaTarget.mockResolvedValueOnce(undefined)
    expect((await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/9')).status).toBe(404)
    instagramMediaTarget.mockResolvedValueOnce({ url: 'https://evil.example/a.mp4', expiresAt: Date.now() + 86_400_000 })
    expect((await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')).status).toBe(404)
    expect((await supertest(app).get('/embed-media/instagram/ab/0')).status).toBe(404)
    expect((await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/..%2Fx')).status).toBe(404)
  })

  it('spends the lookup budget only on posts not yet resolved', async () => {
    instagramMediaTarget.mockResolvedValue({ url: CDN, expiresAt: Date.now() + 86_400_000 })
    await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')
    expect(take).not.toHaveBeenCalled()
    isInstagramPostCached.mockReturnValue(false)
    await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')
    expect(take).toHaveBeenCalledTimes(1)
    expect(take.mock.calls[0][1]).toBe('203.0.113.9')

    take.mockImplementation(async (res: any) => { res.status(429).json({ error: 'Too Many Requests' }); return false })
    instagramMediaTarget.mockClear()
    const limited = await supertest(app).get('/embed-media/instagram/DcCH2ZygIiP/0')
    expect(limited.status).toBe(429)
    expect(instagramMediaTarget).not.toHaveBeenCalled()
  })
})
