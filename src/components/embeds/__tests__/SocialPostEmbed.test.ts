/**
 * Post previews (X, Instagram, Bluesky) in LinkEmbedCard: the author, text and date, every
 * photo in a gallery, videos in Harmony's player, GIFs looping muted, the quoted post, and
 * the media viewer over all items. A preview stored before media and social existed keeps
 * its link card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { EmbedPayload } from '@/types'

const openLightbox = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useLightbox', () => ({ openLightbox, useLightbox: () => ({ open: openLightbox }) }))

const LinkEmbedCard = (await import('../LinkEmbedCard.vue')).default

const RELAY = 'https://har.mony.lol/api/federation/embed-media'
const PHOTO_1 = 'https://pbs.twimg.com/media/A.jpg?name=orig'
const PHOTO_2 = 'https://pbs.twimg.com/media/B.jpg?name=orig'
const CLIP = `${RELAY}?u=${encodeURIComponent('https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/c.mp4')}`
const CLIP_STILL = 'https://pbs.twimg.com/amplify_video_thumb/1/img/c.jpg'
const GIF = `${RELAY}?u=${encodeURIComponent('https://video.twimg.com/tweet_video/G.mp4')}`
const GIF_STILL = 'https://pbs.twimg.com/tweet_video_thumb/G.jpg'

function tweet(over: Partial<EmbedPayload> = {}): EmbedPayload {
  return {
    cacheKey: 'x:https://x.com/NASA/status/1',
    url: 'https://x.com/NASA/status/1',
    normalizedUrl: 'https://x.com/NASA/status/1',
    provider: 'x',
    title: 'NASA (@NASA)',
    description: 'Artemis III hardware',
    siteName: 'X (Twitter)',
    image: PHOTO_1,
    video: { url: CLIP, type: 'video/mp4', width: 720, height: 1280 },
    media: [
      { type: 'image', url: PHOTO_1, width: 1280, height: 1920, alt: 'The core stage' },
      { type: 'image', url: PHOTO_2, width: 1920, height: 1440 },
      { type: 'video', url: CLIP, width: 720, height: 1280, poster: CLIP_STILL, duration: 45.8 },
    ],
    social: {
      platform: 'x',
      url: 'https://x.com/NASA/status/1',
      author: { name: 'NASA', handle: '@NASA', avatar: 'https://pbs.twimg.com/profile_images/1/n_200x200.jpg', url: 'https://x.com/NASA' },
      text: 'Artemis III hardware\nstacked in the VAB',
      publishedAt: '2026-10-20T15:02:42.000Z',
    },
    fetchedAt: '2026-10-22T00:00:00Z',
    expiresAt: '2026-10-22T06:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  openLightbox.mockReset()
})

describe('post previews', () => {
  it('shows the author, text and date, and every photo and the video in the gallery', () => {
    const wrapper = mount(LinkEmbedCard, { props: { payload: tweet() } })
    const card = wrapper.find('[data-testid="social-embed"]')
    expect(card.exists()).toBe(true)
    expect(wrapper.find('.link-embed-card').exists()).toBe(false)
    expect(card.attributes('data-platform')).toBe('x')
    expect(card.find('.social-embed__name').text()).toBe('NASA')
    expect(card.find('.social-embed__name').attributes('href')).toBe('https://x.com/NASA')
    expect(card.find('.social-embed__handle').text()).toBe('@NASA')
    expect(card.find('.social-embed__avatar').attributes('src')).toBe('https://pbs.twimg.com/profile_images/1/n_200x200.jpg')
    expect(card.find('[data-testid="social-embed-text"]').text()).toBe('Artemis III hardware\nstacked in the VAB')
    expect(card.find('time').attributes('datetime')).toBe('2026-10-20T15:02:42.000Z')
    expect(card.find('.social-embed__date').attributes('href')).toBe('https://x.com/NASA/status/1')

    const tiles = card.findAll('.emg__tile')
    expect(tiles.map((t) => t.attributes('data-media-type'))).toEqual(['image', 'image', 'video'])
    expect(tiles[0].find('img').attributes('src')).toBe(PHOTO_1)
    expect(tiles[0].find('img').attributes('alt')).toBe('The core stage')
    const video = tiles[2].find('video')
    expect(video.attributes('src')).toBe(CLIP)
    expect(video.attributes('poster')).toBe(CLIP_STILL)
    expect(tiles[2].find('[data-testid="video-controls"]').exists()).toBe(true)
    expect(card.find('.emg').classes()).toContain('emg--3')
  })

  it('opens the viewer over all items at the photo clicked', async () => {
    const wrapper = mount(LinkEmbedCard, { props: { payload: tweet() } })
    // The opener is named by its place, then the photo's description (useT returns keys here).
    expect(wrapper.findAll('.emg__tile')[0].find('button').attributes('aria-label')).toBe('embeds.openMedia: The core stage')
    expect(wrapper.findAll('.emg__tile')[1].find('button').attributes('aria-label')).toBe('embeds.openMedia')
    await wrapper.findAll('.emg__tile')[1].find('button').trigger('click')
    expect(openLightbox).toHaveBeenCalledTimes(1)
    const [items, index, options] = openLightbox.mock.calls[0]
    expect(index).toBe(1)
    expect(items).toEqual([
      { url: PHOTO_1, type: 'image', alt: 'The core stage' },
      { url: PHOTO_2, type: 'image', alt: undefined },
      { url: CLIP, type: 'video', poster: CLIP_STILL, alt: undefined, loop: false },
    ])
    expect(options).toEqual({ origin: null })
  })

  it("hands the playing video to the viewer from the player's expand control", async () => {
    const wrapper = mount(LinkEmbedCard, { props: { payload: tweet() }, attachTo: document.body })
    const tile = wrapper.findAll('.emg__tile')[2]
    await tile.find('[data-testid="video-expand"]').trigger('click')
    expect(openLightbox).toHaveBeenCalledTimes(1)
    const [, index, options] = openLightbox.mock.calls[0]
    expect(index).toBe(2)
    expect(options.origin).toBe(tile.find('video').element)
    wrapper.unmount()
  })

  it('loops a GIF muted in place and opens it in the viewer as a loop', async () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: tweet({ media: [{ type: 'gif', url: GIF, width: 384, height: 384, poster: GIF_STILL }] }) },
    })
    const tile = wrapper.find('.emg__tile')
    const video = tile.find('video')
    expect(video.attributes('src')).toBe(GIF)
    expect(video.attributes()).toHaveProperty('loop')
    expect((video.element as HTMLVideoElement).muted).toBe(true)
    expect(video.attributes()).toHaveProperty('autoplay')
    expect(tile.find('[data-testid="video-controls"]').exists()).toBe(false)
    expect(tile.find('.emg__badge').text()).toBe('GIF')
    await tile.find('button').trigger('click')
    expect(openLightbox.mock.calls[0][0]).toEqual([{ url: GIF, type: 'video', poster: GIF_STILL, alt: undefined, loop: true }])
  })

  it('shows a single item at its own shape', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: tweet({ media: [{ type: 'video', url: CLIP, width: 720, height: 1280, poster: CLIP_STILL }] }) },
    })
    const gallery = wrapper.find('.emg')
    expect(gallery.classes()).toContain('emg--1')
    expect(gallery.attributes('style')).toContain('--emg-ratio: 720 / 1280')
  })

  it('shows four tiles of a longer carousel, the fourth naming the rest, and the viewer has them all', async () => {
    const media = Array.from({ length: 7 }, (_, i) => ({ type: 'image' as const, url: `${RELAY}/instagram/C0fQuIUJ875/${i}`, width: 1440, height: 1800 }))
    const wrapper = mount(LinkEmbedCard, {
      props: {
        payload: tweet({
          provider: 'instagram',
          media,
          social: { platform: 'instagram', url: 'https://www.instagram.com/p/C0fQuIUJ875/', author: { name: 'NASA', handle: '@nasa' } },
        }),
      },
    })
    const tiles = wrapper.findAll('.emg__tile')
    expect(tiles).toHaveLength(4)
    expect(tiles[3].find('.emg__more').text()).toBe('+3')
    await tiles[3].find('button').trigger('click')
    const [items, index] = openLightbox.mock.calls[0]
    expect(items).toHaveLength(7)
    expect(index).toBe(3)
    expect(wrapper.find('.social-embed__site').text()).toBe('Instagram')
  })

  it('shows the quoted post with its own media', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: {
        payload: tweet({
          media: [],
          social: {
            ...tweet().social!,
            quote: {
              url: 'https://x.com/bot/status/2',
              author: { name: 'Bot', handle: '@bot' },
              text: 'the quoted words',
              publishedAt: '2026-10-21T00:00:00.000Z',
              media: [{ type: 'video', url: CLIP, poster: CLIP_STILL, width: 1920, height: 1080 }],
            },
          },
        }),
      },
    })
    const quote = wrapper.find('[data-testid="social-embed-quote"]')
    expect(quote.exists()).toBe(true)
    expect(quote.find('.social-embed__name').text()).toBe('Bot')
    expect(quote.find('.social-embed__name').attributes('href')).toBe('https://x.com/bot/status/2')
    expect(quote.find('.social-embed__quote-text').text()).toBe('the quoted words')
    expect(quote.find('.emg').classes()).toContain('emg--compact')
    expect(quote.find('video').attributes('src')).toBe(CLIP)
    // The post itself has no media of its own.
    expect(wrapper.findAll('.emg')).toHaveLength(1)
  })

  const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
  const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  const HLS = 'https://video.bsky.app/watch/did%3Aplc%3Ax/bafk/playlist.m3u8'
  const BLOB = `${RELAY}?u=${encodeURIComponent('https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did:plc:x&cid=bafk')}`
  const HLS_STILL = 'https://video.bsky.app/watch/did%3Aplc%3Ax/bafk/thumbnail.jpg'
  const bluesky = (media: EmbedPayload['media']) => tweet({
    provider: 'bluesky',
    media,
    social: { platform: 'bluesky', url: 'https://bsky.app/profile/bsky.app/post/3mx', author: { name: 'Bluesky', handle: '@bsky.app' } },
  })

  /** An engine: its User-Agent, and what its video elements answer for HLS. */
  function asEngine(ua: string, hls: CanPlayTypeResult) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
      type === 'application/vnd.apple.mpegurl' ? hls : 'probably')
  }

  it('plays the HLS alternative where HLS is native (WebKit), the file elsewhere', async () => {
    const media = [{ type: 'video' as const, url: BLOB, hls: HLS, poster: HLS_STILL }]
    asEngine(SAFARI_UA, 'maybe')
    const webkit = mount(LinkEmbedCard, { props: { payload: bluesky(media) } })
    expect(webkit.find('.emg__tile video').attributes('src')).toBe(HLS)
    await webkit.find('[data-testid="video-expand"]').trigger('click')
    expect(openLightbox.mock.calls[0][0][0].url).toBe(HLS)
    vi.restoreAllMocks()

    // Chromium answers 'maybe' for HLS and still plays the file.
    asEngine(CHROME_UA, 'maybe')
    expect(mount(LinkEmbedCard, { props: { payload: bluesky(media) } }).find('.emg__tile video').attributes('src')).toBe(BLOB)
    vi.restoreAllMocks()

    asEngine('Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0', '')
    expect(mount(LinkEmbedCard, { props: { payload: bluesky(media) } }).find('.emg__tile video').attributes('src')).toBe(BLOB)
    vi.restoreAllMocks()
  })

  it('links a video that cannot play here, or that failed, to the post with its still', async () => {
    asEngine(CHROME_UA, 'maybe')
    const wrapper = mount(LinkEmbedCard, {
      props: {
        payload: bluesky([
          { type: 'video', url: HLS, poster: HLS_STILL, mime: 'application/vnd.apple.mpegurl' },
          { type: 'video', url: CLIP, poster: CLIP_STILL },
        ]),
      },
    })
    const tiles = wrapper.findAll('.emg__tile')
    expect(tiles[0].classes()).toContain('emg__tile--link')
    expect(tiles[0].find('a').attributes('href')).toBe('https://bsky.app/profile/bsky.app/post/3mx')
    expect(tiles[0].find('img').attributes('src')).toBe(HLS_STILL)
    expect(tiles[1].classes()).toContain('emg__tile--video')
    await tiles[1].find('video').trigger('error')
    expect(tiles[1].classes()).toContain('emg__tile--link')
    expect(tiles[1].find('img').attributes('src')).toBe(CLIP_STILL)
    vi.restoreAllMocks()

    // WebKit plays an HLS-only video.
    asEngine(SAFARI_UA, 'maybe')
    const webkit = mount(LinkEmbedCard, { props: { payload: bluesky([{ type: 'video', url: HLS, poster: HLS_STILL, mime: 'application/vnd.apple.mpegurl' }]) } })
    expect(webkit.find('.emg__tile').classes()).toContain('emg__tile--video')
    expect(webkit.find('.emg__tile video').attributes('src')).toBe(HLS)
    vi.restoreAllMocks()
  })

  it('folds long text behind Show more', async () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: tweet({ social: { ...tweet().social!, text: 'word '.repeat(120) } }) },
    })
    const text = wrapper.find('[data-testid="social-embed-text"]')
    expect(text.classes()).toContain('social-embed__text--clamped')
    const more = wrapper.find('.social-embed__more')
    expect(more.attributes('aria-expanded')).toBe('false')
    await more.trigger('click')
    expect(wrapper.find('[data-testid="social-embed-text"]').classes()).not.toContain('social-embed__text--clamped')
  })

  it('announces load once its first media paints, at once without media', async () => {
    const withMedia = mount(LinkEmbedCard, { props: { payload: tweet() } })
    expect(withMedia.emitted('load')).toBeUndefined()
    await withMedia.find('.emg__tile img').trigger('load')
    await withMedia.findAll('.emg__tile img')[1].trigger('load')
    expect(withMedia.emitted('load')).toHaveLength(1)

    const textOnly = mount(LinkEmbedCard, { props: { payload: tweet({ media: [], image: undefined, video: undefined }) } })
    expect(textOnly.emitted('load')).toHaveLength(1)
  })
})

describe('previews stored before post media', () => {
  it('keeps the link card for an X preview with only image and description', () => {
    const old = tweet({ media: undefined, social: undefined, video: undefined, provider: 'generic' })
    const wrapper = mount(LinkEmbedCard, { props: { payload: old } })
    expect(wrapper.find('[data-testid="social-embed"]').exists()).toBe(false)
    const card = wrapper.find('.link-embed-card')
    expect(card.exists()).toBe(true)
    expect(card.find('.link-embed-card__title').text()).toBe('NASA (@NASA)')
    expect(card.find('.link-embed-card__media img').attributes('src')).toBe(PHOTO_1)
  })

  it('keeps the small card in the thumbnail and compact variants', () => {
    for (const variant of ['thumbnail', 'compact'] as const) {
      const wrapper = mount(LinkEmbedCard, { props: { payload: tweet(), variant } })
      expect(wrapper.find('[data-testid="social-embed"]').exists()).toBe(false)
      expect(wrapper.find('.link-embed-card').classes()).toContain(`link-embed-card--${variant}`)
    }
  })
})
