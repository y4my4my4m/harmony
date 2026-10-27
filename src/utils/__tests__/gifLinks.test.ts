/**
 * Media-only links: which previews render as media in place of a card, and which lone links
 * show their GIF without their text.
 */
import { describe, it, expect } from 'vitest'
import type { EmbedPayload } from '@/types'
import { isGifPageUrl, linkPreviewMedia, soleGifLinkPart, type LinkPreviewMedia } from '@/utils/gifLinks'

const payload = (url: string, over: Partial<EmbedPayload> = {}): EmbedPayload => ({
  cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'generic',
  fetchedAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-10-28T00:00:00.000Z', ...over,
})

const KLIPY = 'https://klipy.com/gifs/old-man-yells-at-cloud'
const TENOR = 'https://tenor.com/view/cat-typing-gif-12002364'
const GIPHY = 'https://giphy.com/gifs/cat-typing-JIX9t2j0ZTN9S'

describe('isGifPageUrl', () => {
  it.each([KLIPY, TENOR, GIPHY, 'https://www.tenor.com/view/x-gif-1', 'https://KLIPY.com/clips/fall'])('is a GIF page: %s', (url) => {
    expect(isGifPageUrl(url)).toBe(true)
  })

  it.each([
    'https://media.tenor.com/abc/cat.gif',
    'https://klipy.com.evil.example/gifs/x',
    'https://notklipy.com/gifs/x',
    'https://blog.example/posts/dancing',
    'javascript:alert(1)//klipy.com',
    '',
  ])('is no GIF page: %s', (url) => {
    expect(isGifPageUrl(url)).toBe(false)
  })
})

describe('linkPreviewMedia', () => {
  it('renders a GIF page as its GIF, or its looping MP4', () => {
    expect(linkPreviewMedia(payload(KLIPY, { image: 'https://static.klipy.com/a.gif', mediaOnly: true })))
      .toEqual({ kind: 'image', url: 'https://static.klipy.com/a.gif' })
    expect(linkPreviewMedia(payload(TENOR, { image: 'https://media.tenor.com/a.mp4', mediaOnly: true })))
      .toEqual({ kind: 'video', url: 'https://media.tenor.com/a.mp4' })
  })

  it('renders a stored .gif preview as media without the mediaOnly flag', () => {
    expect(linkPreviewMedia(payload(GIPHY, { image: 'https://media.giphy.com/media/x/giphy.gif' })))
      .toEqual({ kind: 'image', url: 'https://media.giphy.com/media/x/giphy.gif' })
  })

  it('plays the video a link answered with', () => {
    expect(linkPreviewMedia(payload('https://vxtwitter.com/a/status/1', { mediaOnly: true, video: { url: 'https://video.twimg.com/a.mp4' } })))
      .toEqual({ kind: 'clip', url: 'https://video.twimg.com/a.mp4' })
  })

  it('leaves cards as cards', () => {
    expect(linkPreviewMedia(payload('https://github.com/a/b', { image: 'https://opengraph.githubassets.com/x' }))).toBeNull()
    expect(linkPreviewMedia(payload('https://en.wikipedia.org/wiki/Cat', { image: 'https://upload.wikimedia.org/cat.gif', mediaOnly: true }))).toBeNull()
    expect(linkPreviewMedia(payload(KLIPY))).toBeNull()
    expect(linkPreviewMedia(null)).toBeNull()
  })
})

describe('soleGifLinkPart', () => {
  const media: Record<string, LinkPreviewMedia> = {
    [KLIPY]: { kind: 'image', url: 'https://static.klipy.com/a.gif' },
    [TENOR]: { kind: 'video', url: 'https://media.tenor.com/a.mp4' },
    [GIPHY]: { kind: 'clip', url: 'https://media.giphy.com/a.mp4' },
    'https://blog.example/posts/dancing': { kind: 'image', url: 'https://blog.example/dancing.gif' },
  }
  const mediaOf = (part: { url?: string }) => (part.url ? media[part.url] ?? null : null)
  const link = (url: string, preview: boolean | 'false' = true) => ({ type: 'url', url, preview })

  it('is the GIF link that is the whole message, whitespace beside it', () => {
    const klipy = link(KLIPY)
    expect(soleGifLinkPart([klipy], mediaOf)).toBe(klipy)
    const tenor = link(TENOR)
    expect(soleGifLinkPart([{ type: 'text', text: ' \n' }, tenor, { type: 'text', text: ' ' }], mediaOf)).toBe(tenor)
  })

  it('is nothing when text, a mention or a second link stands beside it', () => {
    expect(soleGifLinkPart([{ type: 'text', text: 'agreed ' }, link(KLIPY)], mediaOf)).toBeNull()
    expect(soleGifLinkPart([{ type: 'mention', username: 'ann' }, link(KLIPY)], mediaOf)).toBeNull()
    expect(soleGifLinkPart([link(KLIPY), { type: 'text', text: ' ' }, link(TENOR)], mediaOf)).toBeNull()
  })

  it('is nothing for a link without preview, or whose preview has not rendered as a GIF', () => {
    expect(soleGifLinkPart([link(KLIPY, false)], mediaOf)).toBeNull()
    expect(soleGifLinkPart([link(KLIPY, 'false')], mediaOf)).toBeNull()
    expect(soleGifLinkPart([link(KLIPY)], () => null)).toBeNull()
    expect(soleGifLinkPart([link(GIPHY)], mediaOf)).toBeNull()
  })

  it('is nothing for a lone link to a page off the GIF hosts', () => {
    expect(soleGifLinkPart([link('https://blog.example/posts/dancing')], mediaOf)).toBeNull()
  })

  it('is nothing for an empty message', () => {
    expect(soleGifLinkPart([], mediaOf)).toBeNull()
    expect(soleGifLinkPart(null, mediaOf)).toBeNull()
  })
})
