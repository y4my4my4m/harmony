/**
 * Post links in sent content, rewritten to embed-fixer mirrors: X by default, Instagram and
 * Bluesky when picked; post shapes only; mirror links, profiles and code untouched; the
 * mirror chosen from the vetted list.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  MIRROR_HOSTS,
  MIRROR_SITES,
  SOCIAL_SITE_HOSTS,
  mirrorLink,
  resolveMirrorPreferences,
  setMirrorLinkPreferences,
  socialSiteOfHost,
} from '@/utils/mirrorLinks'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'

const defaults = resolveMirrorPreferences(undefined)
const allOn = resolveMirrorPreferences({ x: { enabled: true }, instagram: { enabled: true }, bluesky: { enabled: true } })

describe('mirrorLink', () => {
  it('rewrites X status links to fixupx.com by default, path, query and hash kept', () => {
    expect(mirrorLink('https://x.com/NASA/status/2112560723603632217', defaults)).toBe('https://fixupx.com/NASA/status/2112560723603632217')
    expect(mirrorLink('https://twitter.com/jack/status/20?lang=en#top', defaults)).toBe('https://fixupx.com/jack/status/20?lang=en#top')
    expect(mirrorLink('https://mobile.twitter.com/jack/status/20', defaults)).toBe('https://fixupx.com/jack/status/20')
    expect(mirrorLink('https://www.x.com/NASA/status/1/photo/1', defaults)).toBe('https://fixupx.com/NASA/status/1/photo/1')
    expect(mirrorLink('https://x.com/i/status/20', defaults)).toBe('https://fixupx.com/i/status/20')
  })

  it('leaves Instagram and Bluesky alone by default', () => {
    expect(mirrorLink('https://www.instagram.com/reel/DcCH2ZygIiP/', defaults)).toBe('https://www.instagram.com/reel/DcCH2ZygIiP/')
    expect(mirrorLink('https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m', defaults)).toBe('https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m')
  })

  it('rewrites Instagram posts, reels and tv when picked, without the profile segment', () => {
    expect(mirrorLink('https://www.instagram.com/p/C0fQuIUJ875/', allOn)).toBe('https://kkinstagram.com/p/C0fQuIUJ875/')
    expect(mirrorLink('https://instagram.com/reel/DcCH2ZygIiP?igsh=abc', allOn)).toBe('https://kkinstagram.com/reel/DcCH2ZygIiP/?igsh=abc')
    expect(mirrorLink('https://www.instagram.com/nasa/reel/DcCH2ZygIiP/', allOn)).toBe('https://kkinstagram.com/reel/DcCH2ZygIiP/')
    expect(mirrorLink('https://www.instagram.com/reels/DcCH2ZygIiP/', allOn)).toBe('https://kkinstagram.com/reel/DcCH2ZygIiP/')
    expect(mirrorLink('https://www.instagram.com/tv/DcCH2ZygIiP/', allOn)).toBe('https://kkinstagram.com/tv/DcCH2ZygIiP/')
  })

  it('rewrites Bluesky posts when picked', () => {
    expect(mirrorLink('https://bsky.app/profile/bsky.app/post/3mxyyerrxak2m', allOn)).toBe('https://fxbsky.app/profile/bsky.app/post/3mxyyerrxak2m')
    expect(mirrorLink('https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3mx', allOn))
      .toBe('https://fxbsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3mx')
  })

  it.each([
    ['an X profile', 'https://x.com/NASA'],
    ['the X home page', 'https://x.com/home'],
    ['an X search', 'https://x.com/search?q=status'],
    ['an Instagram profile', 'https://www.instagram.com/nasa/'],
    ['an Instagram explore page', 'https://www.instagram.com/explore/tags/space/'],
    ['a Bluesky profile', 'https://bsky.app/profile/bsky.app'],
    ['a Bluesky feed', 'https://bsky.app/profile/bsky.app/feed/whats-hot'],
    ['a look-alike host', 'https://x.com.evil.example/NASA/status/1'],
    ['a port', 'https://x.com:8443/NASA/status/1'],
  ])('leaves %s alone', (_name, url) => {
    expect(mirrorLink(url, allOn)).toBe(url)
  })

  it.each([
    'https://fixupx.com/NASA/status/1',
    'https://vxtwitter.com/NASA/status/1',
    'https://kkinstagram.com/reel/DcCH2ZygIiP/',
    'https://www.ddinstagram.com/p/DcCH2ZygIiP/',
    'https://fxbsky.app/profile/bsky.app/post/3mx',
  ])('leaves a mirror link alone: %s', (url) => {
    expect(mirrorLink(url, allOn)).toBe(url)
  })

  it('uses the mirror picked from the list, and the default for one off it', () => {
    const picked = resolveMirrorPreferences({
      x: { enabled: true, host: 'vxtwitter.com' },
      instagram: { enabled: true, host: 'eeinstagram.com' },
      bluesky: { enabled: true, host: 'evil.example' },
    })
    expect(mirrorLink('https://x.com/NASA/status/1', picked)).toBe('https://vxtwitter.com/NASA/status/1')
    expect(mirrorLink('https://www.instagram.com/p/C0fQuIUJ875/', picked)).toBe('https://eeinstagram.com/p/C0fQuIUJ875/')
    expect(mirrorLink('https://bsky.app/profile/bsky.app/post/3mx', picked)).toBe('https://fxbsky.app/profile/bsky.app/post/3mx')
    expect(MIRROR_HOSTS.bluesky).not.toContain('evil.example')
  })

  it('knows every pickable mirror as a host of its site', () => {
    for (const site of MIRROR_SITES) {
      for (const host of MIRROR_HOSTS[site]) expect(socialSiteOfHost(host)).toBe(site)
      expect(SOCIAL_SITE_HOSTS[site]).toEqual(expect.arrayContaining([...MIRROR_HOSTS[site]]))
    }
    expect(socialSiteOfHost('www.kkinstagram.com')).toBe('instagram')
    expect(socialSiteOfHost('mobile.twitter.com')).toBe('x')
    expect(socialSiteOfHost('kkinstagram.com.evil.example')).toBeNull()
  })

  it('leaves X alone when turned off', () => {
    const off = resolveMirrorPreferences({ x: { enabled: false } })
    expect(mirrorLink('https://x.com/NASA/status/1', off)).toBe('https://x.com/NASA/status/1')
  })
})

describe('sent content', () => {
  afterEach(() => {
    setMirrorLinkPreferences(undefined)
  })

  const urls = async (text: string) =>
    (await parseContentToMessageParts(text)).filter((p: any) => p.type === 'url').map((p: any) => p.url)
  const texts = async (text: string) =>
    (await parseContentToMessageParts(text)).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')

  it('rewrites bare post links, a link without preview included', async () => {
    expect(await urls('look https://x.com/NASA/status/1 and <https://twitter.com/jack/status/20>'))
      .toEqual(['https://fixupx.com/NASA/status/1', 'https://fixupx.com/jack/status/20'])
    const parts = await parseContentToMessageParts('<https://x.com/NASA/status/1>')
    expect(parts.find((p: any) => p.type === 'url')).toMatchObject({ preview: false })
  })

  it('rewrites the link of a markdown link', async () => {
    expect(await urls('[the launch](https://x.com/NASA/status/1)')).toEqual(['https://fixupx.com/NASA/status/1'])
  })

  it('leaves links in inline code and fenced blocks as typed', async () => {
    expect(await urls('`https://x.com/NASA/status/1`')).toEqual([])
    expect(await texts('`https://x.com/NASA/status/1`')).toContain('https://x.com/NASA/status/1')
    const fenced = '```\ncurl https://x.com/NASA/status/1\n```'
    expect(await urls(fenced)).toEqual([])
    expect(await texts(fenced)).toContain('https://x.com/NASA/status/1')
  })

  it('stores a mirror link without its share trackers, typed on the mirror or rewritten to it', async () => {
    setMirrorLinkPreferences({ instagram: { enabled: true } })
    expect(await urls('https://kkinstagram.com/reel/De-YBL8zRXm/?mdxt=MXN0Z2w5YWF3c2U1eg=='))
      .toEqual(['https://kkinstagram.com/reel/De-YBL8zRXm/'])
    expect(await urls('https://www.instagram.com/nasa/reel/De-YBL8zRXm/?utm_source=ig_web_copy_link&igsh=MXN0Z2w5YWF3c2U1eg==&mdxt=MXN0Z2w5YWF3c2U1eg=='))
      .toEqual(['https://kkinstagram.com/reel/De-YBL8zRXm/'])
    expect(await urls('<https://x.com/NASA/status/1?s=46&t=AbC>')).toEqual(['https://fixupx.com/NASA/status/1'])
    expect(await urls('https://fxbsky.app/profile/bsky.app/post/3mx?ref_src=embed')).toEqual(['https://fxbsky.app/profile/bsky.app/post/3mx'])
  })

  it('keeps share trackers when stripping is turned off in Privacy', async () => {
    localStorage.setItem('harmony-privacy-strip-url-trackers', 'false')
    try {
      expect(await urls('https://kkinstagram.com/reel/De-YBL8zRXm/?mdxt=a')).toEqual(['https://kkinstagram.com/reel/De-YBL8zRXm/?mdxt=a'])
    } finally {
      localStorage.removeItem('harmony-privacy-strip-url-trackers')
    }
  })

  it('follows the preferences set by the visual theme', async () => {
    setMirrorLinkPreferences({ x: { enabled: false }, bluesky: { enabled: true, host: 'bskye.app' } })
    expect(await urls('https://x.com/NASA/status/1 https://bsky.app/profile/bsky.app/post/3mx'))
      .toEqual(['https://x.com/NASA/status/1', 'https://bskye.app/profile/bsky.app/post/3mx'])
  })
})
