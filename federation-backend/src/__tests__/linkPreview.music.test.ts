import { describe, it, expect, vi, beforeEach } from 'vitest'

// Music links: provider tags by host, SoundCloud through oEmbed with its player page,
// Spotify short links through the page they lead to, Bandcamp's player from twitter:player,
// and player pages outside the provider hosts dropped.

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

const { linkPreviewService, providerPlayerUrl } = await import('../services/LinkPreviewService.js')

function answer(body: string, url: string, type: string): Response {
  const res = new Response(body, { status: 200, headers: { 'content-type': type } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

beforeEach(() => {
  safeFetch.mockReset()
})

describe('music previews', () => {
  it('reads SoundCloud through oEmbed and keeps its player page', async () => {
    safeFetch.mockResolvedValue(answer(JSON.stringify({
      title: 'Night Drive by Someone',
      author_name: 'Someone',
      provider_name: 'SoundCloud',
      thumbnail_url: 'https://i1.sndcdn.com/artworks-x-t500x500.jpg',
      height: 400,
      html: '<iframe width="100%" height="400" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?visual=true&amp;url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123&amp;show_artwork=true"></iframe>',
    }), 'https://soundcloud.com/oembed', 'application/json'))
    const p = await linkPreviewService.getPreview('https://soundcloud.com/someone/night-drive')
    expect(p.provider).toBe('soundcloud')
    expect(p.title).toBe('Night Drive by Someone')
    expect(p.player?.url).toBe('https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123&show_artwork=true')
    expect(p.player?.height).toBe(400)
  })

  it('follows a Spotify short link to the item it names', async () => {
    safeFetch
      .mockRejectedValueOnce(new Error('oEmbed request failed (404)'))
      .mockResolvedValueOnce(answer(`<html><head>
        <meta property="og:title" content="Song Name">
        <meta property="og:url" content="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC">
        <meta property="og:image" content="https://i.scdn.co/image/ab67616d.jpg">
      </head></html>`, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', 'text/html'))
    const p = await linkPreviewService.getPreview('https://spotify.link/AbCdEf123')
    expect(p.provider).toBe('spotify')
    expect(p.canonicalUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')
  })

  it("takes Bandcamp's player from twitter:player", async () => {
    safeFetch.mockResolvedValue(answer(`<html><head>
      <meta property="og:title" content="Album, by Band">
      <meta name="twitter:player" content="https://bandcamp.com/EmbeddedPlayer/v=2/album=111/size=large/tracklist=false/artwork=small/">
      <meta name="twitter:player:height" content="142">
    </head></html>`, 'https://band.bandcamp.com/album/album', 'text/html'))
    const p = await linkPreviewService.getPreview('https://band.bandcamp.com/album/album')
    expect(p.provider).toBe('bandcamp')
    expect(p.player).toEqual({ url: 'https://bandcamp.com/EmbeddedPlayer/v=2/album=111/size=large/tracklist=false/artwork=small/', height: 142 })
  })

  it('tags Apple Music, Deezer and Tidal links', async () => {
    safeFetch.mockImplementation(async (url: string) =>
      answer('<html><head><meta property="og:title" content="t"></head></html>', url, 'text/html'))
    expect((await linkPreviewService.getPreview('https://music.apple.com/us/album/x/1440857781?i=1440857795')).provider).toBe('apple-music')
    expect((await linkPreviewService.getPreview('https://www.deezer.com/en/track/3135556')).provider).toBe('deezer')
    expect((await linkPreviewService.getPreview('https://tidal.com/browse/track/77646169')).provider).toBe('tidal')
  })

  it('names only provider player pages', () => {
    expect(providerPlayerUrl('https://evil.example/player')).toBeUndefined()
    expect(providerPlayerUrl('http://w.soundcloud.com/player/?url=x')).toBeUndefined()
    expect(providerPlayerUrl('https://embed.music.apple.com/us/album/x/1')).toBe('https://embed.music.apple.com/us/album/x/1')
  })
})
