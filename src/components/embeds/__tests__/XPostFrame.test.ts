/**
 * X video where the browser cannot play X's file through the instance's redirect (Chromium,
 * Gecko) and the instance relays none: the still, a play button and the length; X's
 * embedded post is framed on the click and never before. WebKit, X GIFs and an instance that
 * relays X video keep the player in place. The viewer shows the same click-to-load frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { EmbedPayload } from '@/types'

const openLightbox = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useLightbox', () => ({ openLightbox, useLightbox: () => ({ open: openLightbox }) }))

const LinkEmbedCard = (await import('../LinkEmbedCard.vue')).default
const { default: XPostFrame, xPostEmbedUrl, xPostId } = await import('../XPostFrame.vue')
const { resetXVideoRelay } = await import('@/composables/useXVideoRelay')
const { default: MediaLightbox } = await import('@/components/common/MediaLightbox.vue')

enableAutoUnmount(afterEach)

// happy-dom would fetch a framed page; these tests load nothing from X.
const happyDOM = (window as unknown as { happyDOM?: { settings?: { disableIframePageLoading?: boolean } } }).happyDOM
if (happyDOM?.settings) happyDOM.settings.disableIframePageLoading = true

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0'
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const RELAY = 'https://har.mony.lol/api/federation/embed-media'
const PHOTO = 'https://pbs.twimg.com/media/A.jpg?name=orig'
const CLIP = `${RELAY}?u=${encodeURIComponent('https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/c.mp4')}`
const STILL = 'https://pbs.twimg.com/amplify_video_thumb/1/img/c.jpg'
const GIF = `${RELAY}?u=${encodeURIComponent('https://video.twimg.com/tweet_video/G.mp4')}`
const EMBED = 'https://platform.twitter.com/embed/Tweet.html?id=2112560723603632217&dnt=true&theme=dark&lang=en'

function tweet(media: EmbedPayload['media']): EmbedPayload {
  return {
    cacheKey: 'x', url: 'https://x.com/NASA/status/2112560723603632217', normalizedUrl: 'https://x.com/NASA/status/2112560723603632217',
    provider: 'x', title: 'NASA (@NASA)', image: PHOTO, media,
    social: { platform: 'x', url: 'https://x.com/NASA/status/2112560723603632217', author: { name: 'NASA', handle: '@NASA' }, text: 'Moon base' },
    fetchedAt: '', expiresAt: '',
  }
}
const withVideo = () => tweet([
  { type: 'image', url: PHOTO, width: 1280, height: 960 },
  { type: 'video', url: CLIP, poster: STILL, width: 720, height: 1280, duration: 45.8, alt: 'Rovers on the Moon' },
])

const fetchMock = vi.fn()
function asEngine(ua: string, relaysXVideo: boolean | 'unreachable' = false) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => relaysXVideo === 'unreachable'
    ? new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response(JSON.stringify({ relaysXVideo }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  openLightbox.mockReset()
  resetXVideoRelay()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('X embed URLs', () => {
  it("names X's embed page of a status, in the app's theme and language", () => {
    expect(xPostId('https://x.com/NASA/status/2112560723603632217/video/1')).toBe('2112560723603632217')
    expect(xPostId('https://twitter.com/i/status/20')).toBe('20')
    expect(xPostId('https://fixupx.com/NASA/status/1')).toBeUndefined()
    expect(xPostId('https://x.com/NASA')).toBeUndefined()
    expect(xPostEmbedUrl('2112560723603632217', { theme: 'dark', lang: 'en' })).toBe(EMBED)
    expect(xPostEmbedUrl('1', { theme: 'light', lang: 'ja' })).toBe('https://platform.twitter.com/embed/Tweet.html?id=1&dnt=true&theme=light&lang=ja')
  })

  it('frames nothing but an X embed page', async () => {
    for (const src of ['https://evil.example/embed/Tweet.html?id=1', 'https://platform.twitter.com/embed/Other.html?id=1', 'https://platform.twitter.com/embed/Tweet.html?id=x']) {
      const frame = mount(XPostFrame, { props: { src, autoload: true } })
      expect(frame.find('iframe').exists()).toBe(false)
    }
  })
})

describe('X video in Chromium and Firefox', () => {
  it.each([['Chromium', CHROME_UA], ['Firefox', FIREFOX_UA]])(
    '%s: the still, a play button and the length; X frames on the click and never before', async (_name, ua) => {
      asEngine(ua)
      const wrapper = mount(LinkEmbedCard, { props: { payload: withVideo() } })
      await flushPromises()
      const tile = wrapper.findAll('.emg__tile')[1]
      expect(tile.classes()).toContain('emg__tile--xframe')
      expect(tile.find('video').exists()).toBe(false)
      expect(tile.find('.xpf__poster').attributes('src')).toBe(STILL)
      expect(tile.find('.xpf__duration').text()).toBe('0:46')
      const start = tile.find('[data-testid="x-post-frame-start"]')
      expect(start.attributes('aria-label')).toBe('embeds.playInX: Rovers on the Moon')
      expect(wrapper.find('iframe').exists()).toBe(false)
      // The instance was asked once whether it relays X video; nothing went to X.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/federation\/embed-media\/config$/)

      await start.trigger('click')
      const frame = wrapper.find('[data-testid="embed-media-x-frame"] iframe')
      expect(frame.exists()).toBe(true)
      expect(frame.attributes('src')).toBe(EMBED)
      expect(frame.attributes('sandbox')).toBe('allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox')
      expect(wrapper.findAll('.emg__tile')).toHaveLength(0)
    })

  it('takes the height X reports for its post', async () => {
    const frame = mount(XPostFrame, { props: { src: EMBED, autoload: true }, attachTo: document.body })
    const iframe = frame.find('iframe').element as HTMLIFrameElement
    const message = { 'twttr.embed': { method: 'twttr.private.resize', params: [{ width: 550, height: 897 }] } }
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message), origin: 'https://platform.twitter.com', source: iframe.contentWindow }))
    await flushPromises()
    expect(iframe.style.height).toBe('897px')
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message).replace('897', '5'), origin: 'https://evil.example', source: iframe.contentWindow }))
    await flushPromises()
    expect(iframe.style.height).toBe('897px')
  })

  it("links the post beneath a frame whose page never answers, and not once X's page has", async () => {
    vi.useFakeTimers()
    try {
      const silent = mount(XPostFrame, { props: { src: EMBED, autoload: true }, attachTo: document.body })
      await vi.advanceTimersByTimeAsync(9_000)
      expect(silent.find('[data-testid="x-post-frame-fallback"]').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      await nextTick()
      const link = silent.find('[data-testid="x-post-frame-fallback"]')
      expect(link.attributes('href')).toBe('https://x.com/i/status/2112560723603632217')
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(silent.find('iframe').exists()).toBe(true)
      silent.unmount()

      const answering = mount(XPostFrame, { props: { src: EMBED, autoload: true }, attachTo: document.body })
      const iframe = answering.find('iframe').element as HTMLIFrameElement
      const rendered = { 'twttr.embed': { method: 'twttr.private.rendered', params: [] } }
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(rendered), origin: 'https://platform.twitter.com', source: iframe.contentWindow }))
      await vi.advanceTimersByTimeAsync(10_000)
      await nextTick()
      expect(answering.find('[data-testid="x-post-frame-fallback"]').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the viewer at a photo with the video as a click-to-load X frame', async () => {
    asEngine(CHROME_UA)
    const wrapper = mount(LinkEmbedCard, { props: { payload: withVideo() } })
    await flushPromises()
    await wrapper.findAll('.emg__tile')[0].find('button').trigger('click')
    const [items, index] = openLightbox.mock.calls[0]
    expect(index).toBe(0)
    expect(items[1]).toEqual({ url: EMBED, type: 'embed', poster: STILL, alt: 'Rovers on the Moon' })
  })

  it('keeps an X GIF looping in place: it comes in one request', async () => {
    asEngine(CHROME_UA)
    const wrapper = mount(LinkEmbedCard, { props: { payload: tweet([{ type: 'gif', url: GIF, poster: STILL, width: 384, height: 384 }]) } })
    await flushPromises()
    expect(wrapper.find('.emg__tile').classes()).toContain('emg__tile--gif')
    expect(wrapper.find('video').attributes('src')).toBe(GIF)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('plays in place where the instance relays X video', async () => {
    asEngine(FIREFOX_UA, true)
    const wrapper = mount(LinkEmbedCard, { props: { payload: withVideo() } })
    await flushPromises()
    const tile = wrapper.findAll('.emg__tile')[1]
    expect(tile.classes()).toContain('emg__tile--video')
    expect(tile.find('video').attributes('src')).toBe(CLIP)
  })

  it('frames X when the instance cannot say', async () => {
    asEngine(CHROME_UA, 'unreachable')
    const wrapper = mount(LinkEmbedCard, { props: { payload: withVideo() } })
    await flushPromises()
    expect(wrapper.findAll('.emg__tile')[1].classes()).toContain('emg__tile--xframe')
  })
})

it('plays X video in place in WebKit through the redirect, asking the instance nothing', async () => {
  asEngine(SAFARI_UA)
  const wrapper = mount(LinkEmbedCard, { props: { payload: withVideo() } })
  await flushPromises()
  const tile = wrapper.findAll('.emg__tile')[1]
  expect(tile.classes()).toContain('emg__tile--video')
  expect(tile.find('video').attributes('src')).toBe(CLIP)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('the viewer frames an X embed item on its click only', async () => {
  mount(MediaLightbox, {
    props: { visible: true, imgs: [{ src: EMBED, type: 'embed', poster: STILL, alt: 'Rovers on the Moon' }], index: 0, download: true, 'onUpdate:index': () => {} },
    attachTo: document.body,
  })
  await flushPromises()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('iframe')).toBeNull()
  expect(dialog.querySelector('[data-testid="lightbox-download"]')).toBeNull()
  const start = dialog.querySelector<HTMLButtonElement>('[data-testid="x-post-frame-start"]')!
  expect(start.querySelector('img')!.getAttribute('src')).toBe(STILL)
  start.click()
  await flushPromises()
  expect(dialog.querySelector('iframe')!.getAttribute('src')).toBe(EMBED)
})
