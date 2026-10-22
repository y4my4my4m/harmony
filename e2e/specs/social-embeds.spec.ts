// Journey: links to posts on X and Instagram show the post: author, text, date, every photo
// and video. An X post with two photos and a video, where the instance relays no X video (the
// default), shows the video's still and length; the viewer steps through all three and shows
// the same still; a click frames X's embedded post, and nothing loads from X before it. Where
// the instance relays X video, it plays in place in Harmony's player. An Instagram reel plays
// in place. A preview stored before posts carried their media keeps its link card, beside a
// post preview of today.
//
// The stack runs no federation backend: previews are written into message metadata as the
// backend's enrichment writes them, and the instance's relay answer is routed. The media are
// fixtures served at the URLs a preview names: the 6 s VP9/Opus WebM clip (Playwright's
// Chromium has no H.264) for the relay's video URLs, generated SVG pictures for the photos, a
// stub of X's embed page that reports its height as X's does.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))
const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${fill}"/><circle cx="400" cy="300" r="120" fill="#fff"/></svg>`

const RELAY = 'https://har.mony.test/api/federation/embed-media'
const TWEET = 'https://x.com/NASA/status/2112560723603632217'
const OLD_TWEET = 'https://x.com/NASAArtemis/status/2110094787760078990'
const REEL = 'https://www.instagram.com/reel/DcCH2ZygIiP/'
const PHOTO_1 = 'https://pbs.twimg.com/media/HUiP9IrX0AARv5Q.jpg?name=orig'
const PHOTO_2 = 'https://pbs.twimg.com/media/HUiP9WsWMAAUlkf.jpg?name=orig'
const STILL = 'https://pbs.twimg.com/media/HVFSyBvWAAE5Y1_.jpg'
const AVATAR = 'https://pbs.twimg.com/profile_images/1321163587679784960/0ZxKlEKB_200x200.jpg'
const CLIP_URL = `${RELAY}?u=${encodeURIComponent('https://video.twimg.com/amplify_video/2112560648005484545/vid/avc1/720x1280/qnC_V3TZFNCfIUeO.mp4?tag=16')}`
const REEL_URL = `${RELAY}/instagram/DcCH2ZygIiP/0`
const X_EMBED = /^https:\/\/platform\.twitter\.com\/embed\/Tweet\.html\?id=2112560723603632217&dnt=true&theme=(dark|light)/
// X's embed page posts twttr.private.resize with its height to the framing page.
const X_EMBED_STUB = `<!doctype html><body style="margin:0;background:#15202b;color:#fff">NASA embedded post<script>
parent.postMessage(JSON.stringify({ 'twttr.embed': { jsonrpc: '2.0', method: 'twttr.private.resize', params: [{ width: 550, height: 640 }] } }), '*')
</script></body>`

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const stamp = () => ({ fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() })

// As LinkPreviewService stores an X post today.
const tweetPreview = {
  cacheKey: `x:${TWEET}`, url: TWEET, normalizedUrl: TWEET, provider: 'x',
  title: 'NASA (@NASA)', description: 'Two photos and a clip from the pad', siteName: 'X (Twitter)',
  image: PHOTO_1, width: 1280, height: 1920, icon: AVATAR,
  video: { url: CLIP_URL, type: 'video/mp4', width: 640, height: 360 },
  media: [
    { type: 'image', url: PHOTO_1, width: 1280, height: 1920, alt: 'The core stage in the VAB' },
    { type: 'image', url: PHOTO_2, width: 1920, height: 1440 },
    { type: 'video', url: CLIP_URL, width: 640, height: 360, poster: STILL, duration: 6 },
  ],
  social: {
    platform: 'x', url: TWEET,
    author: { name: 'NASA', handle: '@NASA', avatar: AVATAR, url: 'https://x.com/NASA' },
    text: 'Two photos and a clip from the pad', publishedAt: '2026-10-20T15:02:42.000Z',
  },
  ...stamp(),
}

// As LinkPreviewService stores an Instagram reel today.
const reelPreview = {
  cacheKey: `instagram:${REEL}`, url: REEL, normalizedUrl: REEL, provider: 'instagram',
  title: 'NASA (@nasa)', description: 'Air show at Kennedy', siteName: 'Instagram',
  image: `${RELAY}/instagram/DcCH2ZygIiP/0/poster`, width: 720, height: 1280, icon: `${RELAY}/instagram/DcCH2ZygIiP/avatar`,
  video: { url: REEL_URL, type: 'video/mp4', width: 720, height: 1280 },
  canonicalUrl: 'https://www.instagram.com/p/DcCH2ZygIiP/',
  media: [{ type: 'video', url: REEL_URL, width: 720, height: 1280, poster: `${RELAY}/instagram/DcCH2ZygIiP/0/poster` }],
  social: {
    platform: 'instagram', url: 'https://www.instagram.com/p/DcCH2ZygIiP/',
    author: { name: 'NASA', handle: '@nasa', avatar: `${RELAY}/instagram/DcCH2ZygIiP/avatar`, url: 'https://www.instagram.com/nasa/' },
    text: 'Air show at Kennedy', publishedAt: '2026-08-14T20:01:26.000Z',
  },
  ...stamp(),
}

// As 1.8.10 stored an X post: the first photo, the text, no media list.
const oldTweetPreview = {
  cacheKey: `generic:${OLD_TWEET}`, url: OLD_TWEET, normalizedUrl: OLD_TWEET, provider: 'generic',
  title: 'NASA Artemis (@NASAArtemis)', description: 'Stacking operations continue', siteName: 'X (Twitter)',
  image: PHOTO_2, width: 1920, height: 1440, icon: AVATAR,
  ...stamp(),
}

async function post(label: string, url: string, embed: Record<string, unknown>, at: number) {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `${label} ` }, { type: 'url', url }],
    metadata: { embeds: { [url]: embed } },
    created_at: new Date(at).toISOString(),
  })
  if (error) throw new Error(`message ${label}: ${error.message}`)
}

test.beforeAll(async () => {
  user = await createUser(admin, 'soc')
  server = await seedServer(admin, user, `Posts ${user.username}`)
  const t0 = Date.now() - 60_000
  await post('oldtweet', OLD_TWEET, oldTweetPreview, t0)
  await post('reel', REEL, reelPreview, t0 + 1000)
  await post('xpost', TWEET, tweetPreview, t0 + 2000)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function serveMedia(page: Page, relaysXVideo = false) {
  await page.route('**/api/federation/embed-media/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ relaysXVideo }) }))
  await page.route(`${RELAY}**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/poster') || url.pathname.endsWith('/avatar')) {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: picture('#e1306c') })
    }
    return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } })
  })
  await page.route('https://pbs.twimg.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: picture('#0ea5e9') }))
}

const row = (page: Page, label: string) => messageList(page).locator('.message-item').filter({ hasText: `${label} ` })
const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const position = (page: Page) => viewer(page).locator('.lightbox-position')
const time = (video: Locator) => video.evaluate((el: HTMLVideoElement) => el.currentTime)

async function open(page: Page, relaysXVideo = false) {
  await serveMedia(page, relaysXVideo)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
}

test('an X post with two photos and a video shows its still and frames X\'s post on the click', async ({ page }) => {
  test.setTimeout(180_000)
  const xRequests: string[] = []
  await page.route('https://platform.twitter.com/**', (route) => {
    xRequests.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/html', body: X_EMBED_STUB })
  })
  await open(page)
  const card = row(page, 'xpost').locator('[data-testid="social-embed"]')
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card).toHaveAttribute('data-platform', 'x')
  await expect(card.locator('.social-embed__name')).toHaveText('NASA')
  await expect(card.locator('.social-embed__handle')).toHaveText('@NASA')
  await expect(card.getByTestId('social-embed-text')).toHaveText('Two photos and a clip from the pad')
  await expect(card.locator('time')).toHaveAttribute('datetime', '2026-10-20T15:02:42.000Z')

  const tiles = card.locator('.emg__tile')
  await expect(tiles).toHaveCount(3)
  await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', PHOTO_1)
  await expect(tiles.nth(1).locator('img')).toHaveAttribute('src', PHOTO_2)

  const still = tiles.nth(2).getByTestId('x-post-frame-start')
  await test.step('the video shows its still, a play button and its length; nothing loads from X', async () => {
    await expect(tiles.nth(2)).toHaveClass(/emg__tile--xframe/)
    await expect(still.locator('img')).toHaveAttribute('src', STILL)
    await expect(still.locator('.xpf__duration')).toHaveText('0:06')
    await expect(still).toHaveAccessibleName(/Play in X's player/)
    await expect(tiles.nth(2).locator('video')).toHaveCount(0)
    await expect(page.locator('iframe[src*="platform.twitter.com"]')).toHaveCount(0)
    expect(xRequests).toEqual([])
  })

  await test.step('a photo opens the viewer, which steps to the other photo and the video\'s still', async () => {
    await tiles.nth(0).getByRole('button', { name: 'Open media 1 of 3: The core stage in the VAB' }).click()
    await expect(position(page)).toHaveText('1 of 3')
    await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', PHOTO_1)
    const next = viewer(page).getByRole('button', { name: 'Next' })
    await next.click()
    await expect(position(page)).toHaveText('2 of 3')
    await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', PHOTO_2)
    await next.click()
    await expect(position(page)).toHaveText('3 of 3')
    await expect(viewer(page).getByTestId('x-post-frame-start').locator('img')).toHaveAttribute('src', STILL)
    await expect(viewer(page).locator('iframe')).toHaveCount(0)
    await expect(viewer(page).getByTestId('lightbox-download')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toHaveCount(0)
    expect(xRequests).toEqual([])
  })

  await test.step('the click frames X\'s embedded post in place of the photos, at the height X reports', async () => {
    await still.click()
    const frame = card.getByTestId('embed-media-x-frame').locator('iframe')
    await expect(frame).toHaveAttribute('src', X_EMBED)
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox')
    await expect(card.locator('.emg__tile')).toHaveCount(0)
    await expect(frame).toHaveCSS('height', '640px')
    await expect(page.frameLocator('[data-testid="embed-media-x-frame"] iframe').locator('body')).toHaveText('NASA embedded post')
    expect(xRequests).toHaveLength(1)
    await expect(card.getByTestId('x-post-frame-fallback')).toHaveCount(0)
  })
})

test('where the instance relays X video, it plays in place and steps through the viewer', async ({ page }) => {
  test.setTimeout(180_000)
  await open(page, true)
  const card = row(page, 'xpost').locator('[data-testid="social-embed"]')
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card).toHaveAttribute('data-platform', 'x')
  await expect(card.locator('.social-embed__name')).toHaveText('NASA')
  await expect(card.locator('.social-embed__handle')).toHaveText('@NASA')
  await expect(card.getByTestId('social-embed-text')).toHaveText('Two photos and a clip from the pad')
  await expect(card.locator('time')).toHaveAttribute('datetime', '2026-10-20T15:02:42.000Z')

  const tiles = card.locator('.emg__tile')
  await expect(tiles).toHaveCount(3)
  await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', PHOTO_1)
  await expect(tiles.nth(1).locator('img')).toHaveAttribute('src', PHOTO_2)
  const inline = tiles.nth(2).locator('video')
  await expect(inline).toHaveAttribute('src', CLIP_URL)

  const player = tiles.nth(2).getByTestId('video-controls')
  await test.step('the video plays in place in Harmony\'s player', async () => {
    await expect.poll(async () => Number(await player.getByTestId('video-seek').getAttribute('aria-valuemax')), { timeout: 15000 }).toBe(6)
    await player.hover()
    await player.getByTestId('video-play').click()
    await expect.poll(() => time(inline), { timeout: 10000 }).toBeGreaterThan(1)
  })

  await test.step('expand opens the viewer on the video, third of three', async () => {
    await player.hover()
    await player.getByTestId('video-expand').click()
    await expect(viewer(page)).toBeVisible()
    await expect(position(page)).toHaveText('3 of 3')
    await expect(viewer(page).locator('video')).toHaveAttribute('src', CLIP_URL)
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toHaveCount(0)
  })

  await test.step('a photo opens the viewer, which steps to the other photo and the video', async () => {
    await tiles.nth(0).getByRole('button', { name: 'Open media 1 of 3: The core stage in the VAB' }).click()
    await expect(position(page)).toHaveText('1 of 3')
    await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', PHOTO_1)
    const next = viewer(page).getByRole('button', { name: 'Next' })
    await next.click()
    await expect(position(page)).toHaveText('2 of 3')
    await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', PHOTO_2)
    await next.click()
    await expect(position(page)).toHaveText('3 of 3')
    await expect(viewer(page).locator('video')).toHaveAttribute('src', CLIP_URL)
  })
})

test('an Instagram reel plays in place', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const card = row(page, 'reel').locator('[data-testid="social-embed"]')
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card).toHaveAttribute('data-platform', 'instagram')
  await expect(card.locator('.social-embed__handle')).toHaveText('@nasa')
  await expect(card.locator('.social-embed__site')).toHaveText('Instagram')
  const video = card.locator('.emg__tile video')
  await expect(video).toHaveAttribute('src', REEL_URL)
  await expect(video).toHaveAttribute('poster', `${RELAY}/instagram/DcCH2ZygIiP/0/poster`)
  const player = card.getByTestId('video-controls')
  await expect.poll(async () => Number(await player.getByTestId('video-seek').getAttribute('aria-valuemax')), { timeout: 15000 }).toBe(6)
  await player.hover()
  await player.getByTestId('video-play').click()
  await expect.poll(() => time(video), { timeout: 10000 }).toBeGreaterThan(1)
})

test('a preview stored before post media keeps its card beside a post preview', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const old = row(page, 'oldtweet')
  const card = old.locator('.link-embed-card')
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card.locator('.link-embed-card__title')).toHaveText('NASA Artemis (@NASAArtemis)')
  await expect(card.locator('.link-embed-card__description')).toHaveText('Stacking operations continue')
  await expect(card.locator('.link-embed-card__media img')).toHaveAttribute('src', PHOTO_2)
  await expect(old.locator('[data-testid="social-embed"]')).toHaveCount(0)

  await expect(row(page, 'xpost').locator('[data-testid="social-embed"]')).toBeVisible()
  await expect(row(page, 'xpost').locator('.link-embed-card')).toHaveCount(0)
})
