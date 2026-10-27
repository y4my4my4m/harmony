import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Previews of X, Instagram and Bluesky posts from recorded answers (fixtures/social-embeds,
// recorded 2026-10-22): every photo and video, author, text, date and quoted post; media
// URLs only on the platforms' CDN hosts, through the instance where the browser cannot load
// them; Instagram from Meta's crawler page, then mirrors, with nothing of the mirror shown.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))
vi.mock('../services/KlipyService.js', () => ({ fetchKlipyMediaBySlug: vi.fn(async () => null) }))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(async () => { throw new Error('not ActivityPub') }) },
}))
const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch,
  validateExternalUrl: (u: string) => new URL(u),
}))

const { linkPreviewService } = await import('../services/LinkPreviewService.js')
const social = await import('../services/socialEmbeds.js')

const fixture = (name: string) => readFileSync(new URL(`./fixtures/social-embeds/${name}`, import.meta.url), 'utf8')
const json = (name: string) => JSON.parse(fixture(name))

type Route = (url: string, init: any) => Response | Promise<Response>
let routes: Array<[RegExp | string, Route]> = []

function respond(body: string, type: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': type } })
}
const jsonAnswer = (data: unknown) => () => respond(JSON.stringify(data), 'application/json')
const htmlAnswer = (html: string) => () => respond(html, 'text/html; charset=utf-8')
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } })
const notFound = () => () => respond('not found', 'text/plain', 404)

function route(match: RegExp | string, answer: Route) {
  routes.push([match, answer])
}

beforeEach(() => {
  routes = []
  safeFetch.mockReset()
  safeFetch.mockImplementation(async (url: string, init: any) => {
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? url === match : match.test(url)) return answer(url, init)
    }
    throw new Error(`unrouted ${url}`)
  })
  social.clearInstagramCache()
  // The fixtures' Instagram CDN URLs expire (oe) from 2026-10-23.
  vi.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z'), toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

let n = 0
const RELAY = 'https://harmony.test/api/federation/embed-media'
const relayed = (url: string) => `${RELAY}?u=${encodeURIComponent(url)}`
const callsTo = (pattern: RegExp) => safeFetch.mock.calls.filter(([u]) => pattern.test(u))

describe('X posts (FxTwitter)', () => {
  it('keeps every photo with its alt text, the author, text and date', async () => {
    route(/^https:\/\/api\.fxtwitter\.com\/NASAArtemis\/status\/2110094787760078990$/, jsonAnswer(json('fxtwitter-photos.json')))
    const preview = await linkPreviewService.getPreview(`https://x.com/NASAArtemis/status/2110094787760078990?n=${++n}`)
    expect(preview.provider).toBe('x')
    expect(preview.media).toHaveLength(4)
    expect(preview.media!.every((m) => m.type === 'image' && m.url.startsWith('https://pbs.twimg.com/media/'))).toBe(true)
    expect(preview.media![0]).toMatchObject({ width: 1280, height: 1920 })
    expect(preview.media![0].alt).toMatch(/^Interior view of NASA/)
    expect(preview.image).toBe(preview.media![0].url)
    expect(preview.video).toBeUndefined()
    expect(preview.social).toMatchObject({
      platform: 'x',
      url: 'https://x.com/NASAArtemis/status/2110094787760078990',
      author: { name: expect.any(String), handle: '@NASAArtemis', url: 'https://x.com/NASAArtemis' },
    })
    expect(preview.social!.author.avatar).toMatch(/^https:\/\/pbs\.twimg\.com\/profile_images\//)
    expect(preview.social!.publishedAt).toMatch(/^2026-10-\d\dT/)
    expect(preview.social!.text).toBeTruthy()
    expect(preview.title).toBe(`${preview.social!.author.name} (@NASAArtemis)`)
  })

  it('plays the 720p H.264 file of a video through the relay, with its still and length', async () => {
    route(/api\.fxtwitter\.com\/NASA\/status\/2112560723603632217$/, jsonAnswer(json('fxtwitter-video.json')))
    const preview = await linkPreviewService.getPreview(`https://x.com/NASA/status/2112560723603632217?n=${++n}`)
    const file = 'https://video.twimg.com/amplify_video/2112560648005484545/vid/avc1/720x1280/qnC_V3TZFNCfIUeO.mp4?tag=16'
    expect(preview.media).toEqual([{
      type: 'video',
      url: relayed(file),
      width: 405,
      height: 720,
      poster: 'https://pbs.twimg.com/media/HVFSyBvWAAE5Y1_.jpg',
      duration: 45.812,
    }])
    // Clients that read only image and video still get the still and a playable file.
    expect(preview.video).toEqual({ url: relayed(file), type: 'video/mp4', width: 405, height: 720 })
    expect(preview.image).toBe('https://pbs.twimg.com/media/HVFSyBvWAAE5Y1_.jpg')
  })

  it('marks a GIF as a looping clip, without a length', async () => {
    route(/api\.fxtwitter\.com\/GIPHY\/status\/1955268195725570451$/, jsonAnswer(json('fxtwitter-gif.json')))
    const preview = await linkPreviewService.getPreview(`https://x.com/GIPHY/status/1955268195725570451?n=${++n}`)
    expect(preview.media).toEqual([{
      type: 'gif',
      url: relayed('https://video.twimg.com/tweet_video/GyKCDw6XYAEGjvH.mp4'),
      width: 384,
      height: 384,
      poster: 'https://pbs.twimg.com/tweet_video_thumb/GyKCDw6XYAEGjvH.jpg',
    }])
  })

  it('carries the quoted post with its media', async () => {
    route(/api\.fxtwitter\.com\/elonmusk\/status\/2113011511429902609$/, jsonAnswer(json('fxtwitter-quote.json')))
    const preview = await linkPreviewService.getPreview(`https://x.com/elonmusk/status/2113011511429902609?n=${++n}`)
    expect(preview.media).toEqual([])
    expect(preview.social!.quote).toMatchObject({
      url: 'https://x.com/bot/status/2112992872857252082',
      author: { handle: '@bot' },
    })
    expect(preview.social!.quote!.media).toHaveLength(1)
    expect(preview.social!.quote!.media![0]).toMatchObject({ type: 'video' })
    expect(preview.social!.quote!.media![0].url.startsWith(`${RELAY}?u=https%3A%2F%2Fvideo.twimg.com%2F`)).toBe(true)
  })

  it('reads mirror links (vxtwitter, fixupx, mobile.twitter) through the same API call', async () => {
    route(/api\.fxtwitter\.com\/GIPHY\/status\/1955268195725570451$/, jsonAnswer(json('fxtwitter-gif.json')))
    for (const host of ['vxtwitter.com', 'fixupx.com', 'mobile.twitter.com', 'd.fxtwitter.com']) {
      const preview = await linkPreviewService.getPreview(`https://${host}/GIPHY/status/1955268195725570451?n=${++n}`)
      expect(preview.provider).toBe('x')
      expect(preview.media).toHaveLength(1)
    }
    expect(callsTo(/fxtwitter\.com\/GIPHY/)).toHaveLength(4)
  })

  it('drops media off the X CDN hosts', async () => {
    const data = json('fxtwitter-photos.json')
    data.tweet.media.all[0].url = 'https://evil.example/a.jpg'
    data.tweet.media.all[1].url = 'http://pbs.twimg.com/media/x.jpg'
    data.tweet.author.avatar_url = 'https://evil.example/avatar.jpg'
    route(/api\.fxtwitter\.com/, jsonAnswer(data))
    const preview = await linkPreviewService.getPreview(`https://x.com/NASAArtemis/status/2110094787760078990?n=${++n}`)
    expect(preview.media).toHaveLength(2)
    expect(preview.social!.author.avatar).toBeUndefined()
  })

  it('falls back to the page when FxTwitter has nothing', async () => {
    route(/api\.fxtwitter\.com/, notFound())
    route(/^https:\/\/x\.com\//, htmlAnswer('<head><meta property="og:title" content="X"></head>'))
    const preview = await linkPreviewService.getPreview(`https://x.com/someone/status/1?n=${++n}`)
    expect(preview.media).toBeUndefined()
    expect(preview.title).toBe('X')
  })
})

describe('X video choice', () => {
  it('takes the highest H.264 bitrate up to 720p, else the lowest', () => {
    const at = (bitrate: number) => ({ container: 'mp4', codec: 'h264', bitrate, url: `https://video.twimg.com/v/${bitrate}.mp4` })
    expect(social.pickTweetVideo({ formats: [at(632000), at(2176000), at(10368000)] })).toBe('https://video.twimg.com/v/2176000.mp4')
    expect(social.pickTweetVideo({ formats: [at(5000000), at(10368000)] })).toBe('https://video.twimg.com/v/5000000.mp4')
    expect(social.pickTweetVideo({ formats: [{ container: 'mp4', codec: 'hevc', bitrate: 1, url: 'https://video.twimg.com/h.mp4' }], url: 'https://video.twimg.com/main.mp4' }))
      .toBe('https://video.twimg.com/main.mp4')
    expect(social.pickTweetVideo({ url: 'https://evil.example/v.mp4' })).toBeUndefined()
  })
})

describe('Instagram posts', () => {
  const CRAWLER = /^https:\/\/www\.instagram\.com\/p\//

  it("reads a reel from the page Meta's crawler gets, behind stable instance URLs", async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-reel.html')))
    const preview = await linkPreviewService.getPreview(`https://www.instagram.com/reel/DcCH2ZygIiP/?n=${++n}`)
    const [, init] = callsTo(CRAWLER)[0]
    expect(init.headers['User-Agent']).toBe(social.META_CRAWLER_USER_AGENT)
    expect(preview.provider).toBe('instagram')
    expect(preview.siteName).toBe('Instagram')
    expect(preview.media).toEqual([{
      type: 'video',
      url: `${RELAY}/instagram/DcCH2ZygIiP/0`,
      poster: `${RELAY}/instagram/DcCH2ZygIiP/0/poster`,
      alt: expect.stringMatching(/^Video by NASA on August 14, 2026\./),
      width: 720,
      height: 1280,
    }])
    expect(preview.video).toEqual({ url: `${RELAY}/instagram/DcCH2ZygIiP/0`, type: 'video/mp4', width: 720, height: 1280 })
    expect(preview.image).toBe(`${RELAY}/instagram/DcCH2ZygIiP/0/poster`)
    expect(preview.social).toMatchObject({
      platform: 'instagram',
      url: 'https://www.instagram.com/p/DcCH2ZygIiP/',
      author: { name: 'NASA', handle: '@nasa', avatar: `${RELAY}/instagram/DcCH2ZygIiP/avatar`, url: 'https://www.instagram.com/nasa/' },
    })
    expect(preview.social!.text).toMatch(/^America’s newest and most exciting aerospace technology expo/)
    expect(preview.social!.publishedAt).toBe(new Date(1786737686 * 1000).toISOString())
    expect(preview.canonicalUrl).toBe('https://www.instagram.com/p/DcCH2ZygIiP/')
  })

  it('keeps every image of a carousel in order', async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-carousel.html')))
    const preview = await linkPreviewService.getPreview(`https://www.instagram.com/p/C0fQuIUJ875/?n=${++n}`)
    expect(preview.media!.map((m) => [m.type, m.url])).toEqual([0, 1, 2, 3].map((i) => ['image', `${RELAY}/instagram/C0fQuIUJ875/${i}`]))
    expect(preview.media![0]).toMatchObject({ width: 1440, height: 1800 })
    const post = await social.resolveInstagramPost('C0fQuIUJ875')
    expect(post!.items.every((item) => item.type === 'image' && /\.cdninstagram\.com$/.test(new URL(item.image!).hostname))).toBe(true)
  })

  it('reads a photo post, also from a profile-prefixed link', async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-photo.html')))
    const preview = await linkPreviewService.getPreview(`https://www.instagram.com/nasa/p/Dcbo8HCGWep/?n=${++n}`)
    expect(preview.media).toHaveLength(1)
    expect(preview.media![0]).toMatchObject({ type: 'image', url: `${RELAY}/instagram/Dcbo8HCGWep/0` })
  })

  it('caches CDN URLs for less than they live, and drops them before they expire', async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-reel.html')))
    const post = await social.resolveInstagramPost('DcCH2ZygIiP')
    expect(post!.expiresAt).toBeGreaterThan(Date.now())
    expect(social.isInstagramPostCached('DcCH2ZygIiP')).toBe(true)
    await social.resolveInstagramPost('DcCH2ZygIiP')
    expect(callsTo(CRAWLER)).toHaveLength(1)
    // At most 30 minutes.
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    expect(social.isInstagramPostCached('DcCH2ZygIiP')).toBe(false)

    // A post whose earliest URL expires in 20 minutes is kept 15.
    social.clearInstagramCache()
    routes = []
    const soon = Math.floor((Date.now() + 20 * 60 * 1000) / 1000).toString(16).toUpperCase()
    route(/^https:\/\/www\.instagram\.com\/p\/Dcbo8HCGWep\//, htmlAnswer(fixture('instagram-crawler-photo.html').replace(/oe=[0-9A-F]+/g, `oe=${soon}`)))
    const short = await social.resolveInstagramPost('Dcbo8HCGWep')
    expect(short!.expiresAt).toBe(parseInt(soon, 16) * 1000)
    vi.setSystemTime(Date.now() + 14 * 60 * 1000)
    expect(social.isInstagramPostCached('Dcbo8HCGWep')).toBe(true)
    vi.setSystemTime(Date.now() + 2 * 60 * 1000)
    expect(social.isInstagramPostCached('Dcbo8HCGWep')).toBe(false)
  })

  it('shares one fetch among concurrent callers', async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-reel.html')))
    await Promise.all([1, 2, 3].map(() => social.resolveInstagramPost('DcCH2ZygIiP')))
    expect(callsTo(CRAWLER)).toHaveLength(1)
  })

  it('reads at most four uncached posts at once, instance-wide', async () => {
    let open = 0
    let peak = 0
    const release: Array<() => void> = []
    route(CRAWLER, async () => {
      open++
      peak = Math.max(peak, open)
      await new Promise<void>((resolve) => release.push(resolve))
      open--
      return notFound()()
    })
    route(/instagram\.com\/p\//, notFound())
    const codes = ['Aaaaa1', 'Aaaaa2', 'Aaaaa3', 'Aaaaa4', 'Aaaaa5', 'Aaaaa6']
    const all = Promise.all(codes.map((code) => social.resolveInstagramPost(code)))
    for (let i = 0; i < 50 && callsTo(CRAWLER).length < codes.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      release.splice(0).forEach((go) => go())
    }
    expect(await all).toEqual(codes.map(() => null))
    expect(callsTo(CRAWLER)).toHaveLength(6)
    expect(peak).toBe(4)
  })

  it('maps media slots to CDN URLs: item, poster, avatar', async () => {
    route(CRAWLER, htmlAnswer(fixture('instagram-crawler-reel.html')))
    const video = await social.instagramMediaTarget('DcCH2ZygIiP', '0')
    const poster = await social.instagramMediaTarget('DcCH2ZygIiP', '0/poster')
    const avatar = await social.instagramMediaTarget('DcCH2ZygIiP', 'avatar')
    expect(new URL(video!.url).pathname).toMatch(/\.mp4$/)
    expect(new URL(poster!.url).pathname).toMatch(/\.jpg$/)
    expect(new URL(avatar!.url).hostname).toMatch(/\.cdninstagram\.com$/)
    expect(video!.expiresAt).toBe(parseInt(new URL(video!.url).searchParams.get('oe')!, 16) * 1000)
    expect(await social.instagramMediaTarget('DcCH2ZygIiP', '1')).toBeUndefined()
    expect(await social.instagramMediaTarget('DcCH2ZygIiP', '../x')).toBeUndefined()
  })

  describe('mirrors, when instagram.com gives no media', () => {
    const mirrorRedirects = json('mirror-redirects.json') as Array<{ url: string; status: number; location: string }>
    const recorded = (url: string) => mirrorRedirects.find((r) => r.url === url)!.location

    beforeEach(() => {
      route(CRAWLER, htmlAnswer(fixture('instagram-page-no-media-json.html')))
    })

    it('takes the CDN file kkinstagram redirects Discordbot to', async () => {
      route('https://kkinstagram.com/p/DcCH2ZygIiP/', redirect(recorded('https://kkinstagram.com/reel/DcCH2ZygIiP/')))
      const preview = await linkPreviewService.getPreview(`https://www.instagram.com/reel/DcCH2ZygIiP/?n=${++n}`)
      const [, init] = callsTo(/kkinstagram\.com/)[0]
      expect(init.headers['User-Agent']).toBe(social.DISCORDBOT_USER_AGENT)
      expect(init.followRedirects).toBe(false)
      expect(init.timeoutMs).toBeLessThanOrEqual(6000)
      expect(preview.media).toMatchObject([{ type: 'video', url: `${RELAY}/instagram/DcCH2ZygIiP/0` }])
      // The page's og:image stands in as the still.
      expect(preview.media![0].poster).toBe(`${RELAY}/instagram/DcCH2ZygIiP/0/poster`)
      const target = await social.instagramMediaTarget('DcCH2ZygIiP', '0')
      expect(target!.url).toBe(recorded('https://kkinstagram.com/reel/DcCH2ZygIiP/'))
      expect(preview.siteName).toBe('Instagram')
    })

    it('goes on to an InstaFix mirror when kkinstagram bounces to instagram.com; shows nothing of the mirror', async () => {
      route('https://kkinstagram.com/p/DcCH2ZygIiP/', redirect('https://www.instagram.com/reel/DcCH2ZygIiP/'))
      route('https://uuinstagram.com/p/DcCH2ZygIiP/', htmlAnswer(fixture('mirror-instafix-reel.html')))
      route('https://uuinstagram.com/videos/DcCH2ZygIiP/1', redirect(recorded('https://uuinstagram.com/videos/DcCH2ZygIiP/1')))
      const preview = await linkPreviewService.getPreview(`https://www.instagram.com/p/DcCH2ZygIiP/?n=${++n}`)
      expect(preview.media).toMatchObject([{ type: 'video', url: `${RELAY}/instagram/DcCH2ZygIiP/0` }])
      expect((await social.instagramMediaTarget('DcCH2ZygIiP', '0'))!.url).toBe(recorded('https://uuinstagram.com/videos/DcCH2ZygIiP/1'))
      const shown = JSON.stringify(preview)
      expect(shown).not.toMatch(/InstaFix|uuinstagram|kkinstagram/)
      expect(preview.social!.author.handle).toBe('@nasa')
      expect(preview.social!.text).toMatch(/^America’s newest/)
    })

    it('refuses mirror answers off the Instagram CDN: ad redirects, foreign og:video, other paths', async () => {
      route('https://kkinstagram.com/p/DcCH2ZygIiP/', redirect('https://www.effectivegatecpm.com/nf52nwk7?key=1', 307))
      route('https://uuinstagram.com/p/DcCH2ZygIiP/', htmlAnswer('<head><meta property="og:video" content="https://evil.example/v.mp4"><meta property="og:image" content="/proxy?url=https://evil.example/x.jpg"></head>'))
      route('https://eeinstagram.com/p/DcCH2ZygIiP/', htmlAnswer('<head><meta property="og:video" content="/videos/DcCH2ZygIiP/1"></head>'))
      route('https://eeinstagram.com/videos/DcCH2ZygIiP/1', redirect('https://evil.example/v.mp4'))
      const preview = await linkPreviewService.getPreview(`https://www.instagram.com/p/DcCH2ZygIiP/?n=${++n}`)
      // Only the og:image Instagram itself served is left.
      expect(preview.media).toEqual([{ type: 'image', url: `${RELAY}/instagram/DcCH2ZygIiP/0` }])
      expect(callsTo(/evil\.example|effectivegatecpm/)).toHaveLength(0)
      const target = await social.instagramMediaTarget('DcCH2ZygIiP', '0')
      expect(new URL(target!.url).hostname).toBe('scontent-nrt1-2.cdninstagram.com')
    })

    it('asks mirrors in INSTAGRAM_EMBED_MIRRORS order', () => {
      expect(social.instagramMirrors()).toEqual(['kkinstagram.com', 'uuinstagram.com', 'eeinstagram.com'])
    })

    it('reads an InstaFix photo page', async () => {
      route('https://kkinstagram.com/p/Dcbo8HCGWep/', () => { throw new Error('timeout') })
      route('https://uuinstagram.com/p/Dcbo8HCGWep/', htmlAnswer(fixture('mirror-instafix-photo.html')))
      route('https://uuinstagram.com/images/Dcbo8HCGWep/1', redirect(recorded('https://uuinstagram.com/images/Dcbo8HCGWep/1')))
      const post = await social.resolveInstagramPost('Dcbo8HCGWep')
      expect(post!.items).toEqual([{ type: 'image', image: recorded('https://uuinstagram.com/images/Dcbo8HCGWep/1') }])
    })
  })

  it('gives no preview, and asks again later, when no source has the post', async () => {
    route(CRAWLER, notFound())
    route(/instagram\.com\/p\//, notFound())
    expect(await social.resolveInstagramPost('Missing0001')).toBeNull()
    expect(social.isInstagramPostCached('Missing0001')).toBe(true)
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    expect(social.isInstagramPostCached('Missing0001')).toBe(false)
  })
})

describe('Bluesky posts', () => {
  const APPVIEW = /^https:\/\/public\.api\.bsky\.app\/xrpc\/app\.bsky\.feed\.getPostThread\?uri=/

  it("plays a video from the author's PDS through /embed-media, with its still and HLS playlist", async () => {
    route(APPVIEW, jsonAnswer(json('bsky-video.json')))
    route('https://plc.directory/did:plc:z72i7hdynmk6r22z27h6tvur', jsonAnswer(json('plc-bsky-app.json')))
    const preview = await linkPreviewService.getPreview('https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m')
    expect(decodeURIComponent(callsTo(APPVIEW)[0][0])).toContain('uri=at://bsky.app/app.bsky.feed.post/3mxyyerrxak2m')
    expect(preview.provider).toBe('bluesky')
    const blob = 'https://puffball.us-east.host.bsky.network/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Az72i7hdynmk6r22z27h6tvur&cid=bafkreiat76ppqns6bcnxnt6etzlyoar4o75v6wrzwjbh342oxbsebyun5e'
    expect(preview.media).toEqual([expect.objectContaining({
      type: 'video',
      url: relayed(blob),
      width: 1000,
      height: 1000,
      poster: 'https://video.bsky.app/watch/did%3Aplc%3Az72i7hdynmk6r22z27h6tvur/bafkreiat76ppqns6bcnxnt6etzlyoar4o75v6wrzwjbh342oxbsebyun5e/thumbnail.jpg',
    })])
    // WebKit plays the playlist: the PDS ignores byte ranges.
    expect(preview.media![0].hls).toBe('https://video.bsky.app/watch/did%3Aplc%3Az72i7hdynmk6r22z27h6tvur/bafkreiat76ppqns6bcnxnt6etzlyoar4o75v6wrzwjbh342oxbsebyun5e/playlist.m3u8')
    expect(preview.social).toMatchObject({
      platform: 'bluesky',
      url: 'https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m',
      author: { name: 'Bluesky', handle: '@bsky.app', url: 'https://bsky.app/profile/bsky.app' },
      publishedAt: '2026-10-16T16:23:26.498Z',
    })
    expect(preview.social!.text).toMatch(/^v1\.135 is live!/)
    expect(preview.video!.url).toBe(relayed(blob))
  })

  it('falls back to the HLS playlist when the PDS is not run by Bluesky', async () => {
    // A did of its own: the PLC answer of the test above is cached.
    const thread = json('bsky-video.json')
    thread.thread.post.author.did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
    route(APPVIEW, jsonAnswer(thread))
    route('https://plc.directory/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', jsonAnswer({
      ...json('plc-bsky-app.json'),
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.self.example' }],
    }))
    const preview = await linkPreviewService.getPreview(`https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m?n=${++n}`)
    expect(preview.media![0]).toMatchObject({
      type: 'video',
      url: expect.stringMatching(/^https:\/\/video\.bsky\.app\/watch\/.*\/playlist\.m3u8$/),
      mime: 'application/vnd.apple.mpegurl',
    })
    // Clients that read only `video` get no file they cannot play.
    expect(preview.video).toBeUndefined()
    expect(callsTo(/self\.example/)).toHaveLength(0)
  })

  it('keeps every image of a gallery', async () => {
    route(APPVIEW, jsonAnswer(json('bsky-gallery.json')))
    const preview = await linkPreviewService.getPreview('https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g')
    const count = json('bsky-gallery.json').thread.post.embed.items.length
    expect(count).toBeGreaterThan(4)
    expect(preview.media).toHaveLength(count)
    expect(preview.media!.every((m) => m.type === 'image' && m.url.startsWith('https://cdn.bsky.app/img/feed_fullsize/'))).toBe(true)
    expect(preview.media![0].alt).toMatch(/from 4 to 10/)
  })

  it('carries the quoted post of a post with its own media', async () => {
    route(APPVIEW, jsonAnswer(json('bsky-record-with-media.json')))
    const preview = await linkPreviewService.getPreview('https://fxbsky.app/profile/bsky.app/post/3m6zx562tss2c')
    expect(preview.media).toEqual([expect.objectContaining({ type: 'image', width: 591, height: 550 })])
    expect(preview.social!.quote).toMatchObject({
      url: 'https://bsky.app/profile/anisota.net/post/3m6mwoadjbp2d',
      author: { name: 'Anisota', handle: '@anisota.net' },
    })
  })
})

describe('post links', () => {
  it('recognises posts, reels and tv on Instagram and its mirrors, and nothing else', () => {
    expect(social.parseInstagramUrl('https://www.instagram.com/reel/DcCH2ZygIiP/?igsh=x')).toEqual({ code: 'DcCH2ZygIiP' })
    expect(social.parseInstagramUrl('https://instagram.com/tv/DcCH2ZygIiP')).toEqual({ code: 'DcCH2ZygIiP' })
    expect(social.parseInstagramUrl('https://www.kkinstagram.com/p/DdEJpNJIV_e/')).toEqual({ code: 'DdEJpNJIV_e' })
    expect(social.parseInstagramUrl('https://www.instagram.com/nasa/')).toBeNull()
    expect(social.parseInstagramUrl('https://notinstagram.com/p/DcCH2ZygIiP/')).toBeNull()
    expect(social.parseBlueskyUrl('https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3mxyyerrxak2m'))
      .toEqual({ actor: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3mxyyerrxak2m' })
    expect(social.parseBlueskyUrl('https://bsky.app/profile/bsky.app')).toBeNull()
    expect(social.parseTweetUrl('https://twitter.com/jack/status/20')).toEqual({ user: 'jack', id: '20' })
    expect(social.parseTweetUrl('https://x.com/jack')).toBeNull()
  })

  it('reads mirror links with their share trackers stripped as the posts they were', async () => {
    const { stripTrackingParameters } = await import('../utils/urlTrackerStripper.js')
    const cases: Array<[string, string, string]> = [
      ['https://kkinstagram.com/reel/De-YBL8zRXm/?mdxt=MXN0Z2w5YWF3c2U1eg==', 'https://kkinstagram.com/reel/De-YBL8zRXm/', 'instagram'],
      ['https://www.instagram.com/reel/De-YBL8zRXm/?igsh=MXN0Z2w5YWF3c2U1eg==&mdxt=MXN0Z2w5YWF3c2U1eg==&img_index=2',
        'https://www.instagram.com/reel/De-YBL8zRXm/?img_index=2', 'instagram'],
      ['https://fixupx.com/NASA/status/2112560723603632217?s=46&t=AbC', 'https://fixupx.com/NASA/status/2112560723603632217', 'x'],
      ['https://fxbsky.app/profile/bsky.app/post/3mxyyerrxak2m?ref_src=embed', 'https://fxbsky.app/profile/bsky.app/post/3mxyyerrxak2m', 'bluesky'],
    ]
    for (const [sent, stored, platform] of cases) {
      expect(stripTrackingParameters(sent)).toBe(stored)
      expect(social.socialPlatformOf(stored)).toBe(platform)
    }
    const klipy = 'https://static.klipy.com/ii/abc/de/fg/gif.gif?utm_source=partner&s=1'
    expect(stripTrackingParameters(klipy)).toBe(klipy)
  })
})
