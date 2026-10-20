import { describe, it, expect, vi, beforeEach } from 'vitest'

// Generic link previews: meta tags in any attribute order, embed-fixer pages and media
// answers, and failures that carry no error text.

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

const { parseMetaTags, linkPreviewService } = await import('../services/LinkPreviewService.js')

function page(html: string, url: string, type = 'text/html; charset=utf-8'): Response {
  const res = new Response(html, { status: 200, headers: { 'content-type': type } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

let n = 0
const fresh = (path: string) => `https://fixer${++n}.example${path}`

beforeEach(() => {
  safeFetch.mockReset()
})

describe('parseMetaTags', () => {
  it('reads property, name and itemprop in either attribute order and quote style', () => {
    const tags = parseMetaTags(`
      <meta content="jack (@jack)" property="og:title" />
      <meta name='og:description' content='just setting up my twttr'>
      <meta itemprop="image" content="https://pbs.example/a.jpg">
      <meta property="og:title" content="second title" />
      <meta property="og:site_name" content="vxTwitter &amp; friends">`)
    expect(tags.get('og:title')).toBe('jack (@jack)')
    expect(tags.get('og:description')).toBe('just setting up my twttr')
    expect(tags.get('image')).toBe('https://pbs.example/a.jpg')
    expect(tags.get('og:site_name')).toBe('vxTwitter & friends')
  })
})

describe('generic previews', () => {
  it('reads a vxtwitter-style page (content before property, name="og:*")', async () => {
    const url = fresh('/jack/status/20')
    safeFetch.mockResolvedValue(page(`<!DOCTYPE html><html><head>
      <meta property="og:site_name" content="vxTwitter / fixvx">
      <meta name="og:title" content="jack (@jack)" />
      <meta content="just setting up my twttr" property="og:description" />
      <meta content="https://pbs.example/a.jpg" property="og:image" />
      </head><body>${'x'.repeat(10)}</body></html>`, url))
    const preview = await linkPreviewService.getPreview(url)
    expect(preview).toMatchObject({
      title: 'jack (@jack)',
      description: 'just setting up my twttr',
      image: 'https://pbs.example/a.jpg',
      siteName: 'vxTwitter / fixvx',
    })
    expect(preview.failed).toBeUndefined()
  })

  it('sends a user agent embed fixers recognise, and allows plain http', async () => {
    const url = fresh('/p/x/')
    safeFetch.mockResolvedValue(page('<head><title>x</title></head>', url))
    await linkPreviewService.getPreview(url)
    const [, options] = safeFetch.mock.calls.at(-1)!
    expect(options.headers['User-Agent']).toMatch(/HarmonyLinkPreview\/1\.0/)
    expect(options.headers['User-Agent']).toMatch(/facebookexternalhit\/1\.1/)
    expect(options.headers['User-Agent']).toMatch(/Discordbot\/2\.0/)
    expect(options.allowPlainHttp).toBe(true)
  })

  it('carries an og:video file, not an HTML player page', async () => {
    const url = fresh('/status/1')
    safeFetch.mockResolvedValue(page(`<head>
      <meta property="og:title" content="clip">
      <meta property="og:video" content="https://video.example/v.mp4">
      <meta property="og:video:type" content="video/mp4">
      <meta property="og:video:width" content="720"><meta property="og:video:height" content="1280">
      </head>`, url))
    expect((await linkPreviewService.getPreview(url)).video).toEqual({
      url: 'https://video.example/v.mp4', type: 'video/mp4', width: 720, height: 1280,
    })

    const player = fresh('/watch')
    safeFetch.mockResolvedValue(page(`<head><meta property="og:title" content="t">
      <meta property="og:video" content="https://player.example/embed/1"><meta property="og:video:type" content="text/html"></head>`, player))
    expect((await linkPreviewService.getPreview(player)).video).toBeUndefined()
  })

  it('turns a link answering with a video into a media-only video preview', async () => {
    const url = fresh('/p/DdEJpNJIV_e/')
    safeFetch.mockResolvedValue(page('', 'https://cdn.example/reel.mp4', 'video/mp4'))
    const preview = await linkPreviewService.getPreview(url)
    expect(preview).toMatchObject({ mediaOnly: true, video: { url: 'https://cdn.example/reel.mp4', type: 'video/mp4' } })
  })

  it('turns a link answering with an image into a media-only image preview', async () => {
    const url = fresh('/i/1')
    safeFetch.mockResolvedValue(page('', 'https://cdn.example/a.png', 'image/png'))
    expect(await linkPreviewService.getPreview(url)).toMatchObject({ mediaOnly: true, image: 'https://cdn.example/a.png' })
  })

  it('marks an unreadable page failed, without the error text, and retries it later', async () => {
    const url = fresh('/')
    safeFetch.mockRejectedValue(new Error('This operation was aborted'))
    const preview = await linkPreviewService.getPreview(url)
    expect(preview.failed).toBe(true)
    expect(preview.description).toBeUndefined()
    expect(new Date(preview.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it('reads only up to the end of <head>', async () => {
    const url = fresh('/big')
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled === 1) controller.enqueue(new TextEncoder().encode('<head><meta property="og:title" content="Big"></head>'))
        else controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)))
      },
    })
    const res = new Response(body, { headers: { 'content-type': 'text/html' } })
    Object.defineProperty(res, 'url', { value: url })
    safeFetch.mockResolvedValue(res)
    expect((await linkPreviewService.getPreview(url)).title).toBe('Big')
    expect(pulled).toBeLessThanOrEqual(2)
  })

  it("names the site's card image", async () => {
    const github = fresh('/AjncSystem/ShadowOfTheColossus-PC')
    const og = 'https://opengraph.githubassets.com/f04c/AjncSystem/ShadowOfTheColossus-PC'
    safeFetch.mockResolvedValue(page(`<head><meta property="og:title" content="GitHub - repo">
      <meta property="og:description" content="A port"><meta property="og:image" content="${og}"></head>`, github))
    expect((await linkPreviewService.getPreview(github)).image).toBe(og)
  })
})

describe('Wikipedia previews', () => {
  const GIF = 'https://upload.wikimedia.org/wikipedia/en/2/27/Moustapha_Akkad.gif?utm_source=en.wikipedia.org'

  it('reads the REST page summary: title, lead extract and thumbnail, as a card', async () => {
    const extract = 'Moustapha al Akkad was a Syrian-American film producer and director. '.repeat(6)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'standard',
      title: 'Moustapha Akkad',
      description: 'Syrian-American director (1930–2005)',
      extract,
      thumbnail: { source: GIF, width: 100, height: 138 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const preview = await linkPreviewService.getPreview('https://en.m.wikipedia.org/wiki/Moustapha_Akkad')
      expect(fetchSpy.mock.calls[0][0]).toBe('https://en.wikipedia.org/api/rest_v1/page/summary/Moustapha_Akkad')
      expect(preview).toMatchObject({ title: 'Moustapha Akkad', siteName: 'Wikipedia', image: GIF, width: 100, height: 138 })
      expect(preview.mediaOnly).toBeFalsy()
      expect(preview.description!.length).toBeLessThanOrEqual(300)
      expect(preview.description!.endsWith('…')).toBe(true)
      expect(safeFetch).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('a still GIF og:image on a Wikimedia page is no GIF page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
    try {
      const url = 'https://commons.wikimedia.org/wiki/File:Moustapha_Akkad.gif'
      safeFetch.mockResolvedValue(page(`<head><meta property="og:title" content="File:Moustapha Akkad.gif">
        <meta property="og:image" content="${GIF}"></head>`, url))
      expect((await linkPreviewService.getPreview(url)).mediaOnly).toBeFalsy()

      const gifSite = fresh('/view/cat')
      safeFetch.mockResolvedValue(page(`<head><meta property="og:title" content="Cat">
        <meta property="og:image" content="https://media.example/cat.gif"></head>`, gifSite))
      expect((await linkPreviewService.getPreview(gifSite)).mediaOnly).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
