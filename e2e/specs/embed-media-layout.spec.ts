// Journey: rich embeds size to their media. A YouTube Short's card narrows to its 9:16
// frame; a link preview whose content is an image or a video stacks the media above the
// text at its own aspect and the card narrows to it, instead of a 100px thumbnail beside
// the text. An embed has no header row: its actions are icon buttons named for screen
// readers on a rail beside the card's top edge, shown on pointing at or focusing the embed
// and always on touch screens. Hide leaves one row naming the provider, with Show. A link
// card whose image does not load (GitHub's card images answer 429 to cache misses) shows
// the site's icon in its place, never the image's alt text.
//
// The stack runs no federation backend: previews are written into message metadata as the
// backend's enrichment writes them.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
// 576x1024, 9:16.
const PORTRAIT = new URL('/assets/skins/sdr-001-preview.png', BASE_URL).href
const SHORT = 'https://www.youtube.com/shorts/4ZnfU3_sErw'
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const TALL = 'https://gif.example/tall'
const CLIP = 'https://vxtwitter.com/someone/status/2'
const REPO = 'https://github.com/AjncSystem/ShadowOfTheColossus-PC'
const REPO_CARD = 'https://opengraph.githubassets.com/f04cad05/AjncSystem/ShadowOfTheColossus-PC'
const GITHUB_ICON = 'https://github.githubassets.com/favicons/favicon.svg'
// GitHub's favicon: a #24292E octocat on transparency.
const OCTOCAT = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#24292E"/></svg>'

const payload = (url: string, provider: string, over: Record<string, unknown> = {}) => ({
  cacheKey: `${provider}:${url}`, url, normalizedUrl: url, provider,
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
})

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
  user = await createUser(admin, 'eml')
  server = await seedServer(admin, user, `Embeds ${user.username}`)
  const t0 = Date.now() - 60_000
  await post('short', SHORT, payload(SHORT, 'youtube', { title: 'A short' }), t0)
  await post('watch', WATCH, payload(WATCH, 'youtube', { title: 'A video' }), t0 + 1000)
  await post('tall', TALL, payload(TALL, 'generic', { title: 'tall gif page', siteName: 'gif.example', image: PORTRAIT }), t0 + 2000)
  await post('clip', CLIP, payload(CLIP, 'generic', {
    title: 'someone (@someone)', description: 'portrait clip', siteName: 'vxTwitter',
    image: PORTRAIT, video: { url: PORTRAIT, type: 'video/mp4' },
  }), t0 + 3000)
  await post('repo', REPO, payload(REPO, 'generic', {
    title: 'GitHub - AjncSystem/ShadowOfTheColossus-PC: Native Windows port',
    description: 'Native Windows port of Shadow of the Colossus', siteName: 'GitHub',
    image: REPO_CARD, icon: GITHUB_ICON,
  }), t0 + 4000)
})

/** GitHub as a viewer meets it: the card image rate-limited, the favicon served. */
async function routeGitHub(page: Page) {
  await page.route(`${REPO_CARD}*`, (route) => route.fulfill({
    status: 429, contentType: 'text/html; charset=utf-8', body: 'Too many requests, please try again later.',
  }))
  await page.route(GITHUB_ICON, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: OCTOCAT }))
}

const opacity = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).opacity))

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const width = async (l: Locator) => (await l.boundingBox())?.width ?? 0

test('embeds size to their media and keep their actions on a rail beside the card', async ({ page }) => {
  test.setTimeout(120_000)
  await routeGitHub(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const row = (label: string) => messageList(page).locator('.message-item').filter({ hasText: `${label} ` })
  await expect(row('clip').locator('.link-embed-card')).toBeVisible({ timeout: 30000 })

  await test.step('a Short narrows its card to the 9:16 frame', async () => {
    const card = row('short').locator('.provider-embed__frame')
    const media = card.locator('.provider-embed__media')
    await expect(media).toBeVisible()
    const cardWidth = await width(card)
    expect(cardWidth).toBeLessThanOrEqual(322)
    expect(cardWidth - (await width(media))).toBeLessThanOrEqual(2)
    expect(await width(row('watch').locator('.provider-embed__frame'))).toBeGreaterThan(400)
  })

  await test.step('no header row: the media starts at the top of the card, the actions beside it', async () => {
    const embed = row('watch').getByRole('group', { name: 'YouTube' })
    const frame = (await embed.locator('.provider-embed__frame').boundingBox())!
    const media = (await embed.locator('.provider-embed__media').boundingBox())!
    expect(media.y - frame.y).toBeLessThanOrEqual(2)
    const rail = embed.locator('.provider-embed__actions')
    const railBox = (await rail.boundingBox())!
    expect(railBox.x).toBeGreaterThanOrEqual(frame.x + frame.width)
    expect(Math.abs(railBox.y - frame.y)).toBeLessThanOrEqual(1)
    expect(railBox.height).toBeLessThan(frame.height)

    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(rail)).toBe(0)
    await embed.locator('.provider-embed__frame').hover()
    await expect.poll(() => opacity(rail)).toBe(1)
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(rail)).toBe(0)
    await rail.getByRole('button', { name: 'Open' }).focus()
    await expect.poll(() => opacity(rail)).toBe(1)
    await expect(rail.getByRole('button', { name: 'Pop out' })).toBeAttached()
  })

  await test.step('the rail buttons are icons with names; Hide leaves a row naming the provider, Show restores', async () => {
    const embed = row('short').getByRole('group', { name: 'YouTube' })
    await expect(embed.getByRole('button', { name: 'Open' })).toBeAttached()
    const hide = embed.getByRole('button', { name: 'Hide' })
    await expect(hide).toHaveText('')
    await expect(hide).toHaveAttribute('aria-expanded', 'true')

    await hide.click()
    await expect(embed.locator('.provider-embed__media')).toHaveCount(0)
    await expect(embed.locator('.provider-embed__label')).toHaveText('YouTube')
    expect((await embed.boundingBox())?.height ?? 0).toBeLessThanOrEqual(32)
    const show = embed.getByRole('button', { name: 'Show' })
    await expect(show).toBeVisible()
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await show.click()
    await expect(embed.locator('.provider-embed__media')).toBeVisible()
  })

  await test.step("a card image that does not load leaves the site's icon in its place", async () => {
    const card = row('repo').locator('.link-embed-card')
    const tile = card.getByTestId('link-embed-placeholder')
    await expect(tile).toBeVisible({ timeout: 15000 })
    await expect(card.locator('.link-embed-card__media > img')).toHaveCount(0)
    await expect(card).not.toContainText('ShadowOfTheColossus-PC: Native Windows port Native')
    await expect(tile.locator('img')).toHaveAttribute('src', GITHUB_ICON)
    const tileBox = (await tile.boundingBox())!
    expect(tileBox.width).toBeGreaterThanOrEqual(90)
    const iconBox = (await tile.locator('img').boundingBox())!
    expect(iconBox.width).toBe(32)
    expect(Math.abs(iconBox.x + iconBox.width / 2 - (tileBox.x + tileBox.width / 2))).toBeLessThanOrEqual(1)
    // The dark octocat sits on a light chip, in the tile and beside the site name.
    for (const icon of [tile.locator('img'), card.locator('.link-embed-card__icon')]) {
      await expect(icon).toBeVisible()
      expect(await icon.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    }
  })

  await test.step('an image preview stacks its image and narrows to it', async () => {
    const card = row('tall').locator('.provider-embed__frame')
    const image = card.locator('.link-embed-card__media img')
    await expect(card.locator('.link-embed-card--media')).toBeVisible()
    await expect(image).toBeVisible()
    const imageBox = await image.boundingBox()
    expect(imageBox!.height).toBeGreaterThan(imageBox!.width * 1.5)
    expect(await width(card)).toBeLessThan(260)
  })

  await test.step('a video preview plays at its own size, not as a thumbnail', async () => {
    const card = row('clip').locator('.provider-embed__frame')
    const video = card.locator('.link-embed-card__media video')
    await expect(card.locator('.link-embed-card--media')).toBeVisible()
    await expect(video).toHaveAttribute('src', PORTRAIT)
    await expect.poll(async () => (await video.boundingBox())?.height ?? 0, { timeout: 10000 }).toBeGreaterThan(300)
    expect(await width(card)).toBeLessThan(260)
    await expect(card).toContainText('portrait clip')
  })
})

test.describe('on a touch screen', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the rail shows without pointing, and fits beside the card', async ({ page }) => {
    test.setTimeout(120_000)
    await routeGitHub(page)
    await signIn(page, user)
    await openChannel(page, server.id, server.generalChannelId)
    const embed = messageList(page).locator('.message-item').filter({ hasText: 'watch ' }).getByRole('group', { name: 'YouTube' })
    await expect(embed.locator('.provider-embed__media')).toBeVisible({ timeout: 30000 })
    const rail = embed.locator('.provider-embed__actions')
    await expect.poll(() => opacity(rail)).toBe(1)
    const viewport = page.viewportSize()!
    const railBox = (await rail.boundingBox())!
    expect(railBox.x + railBox.width).toBeLessThanOrEqual(viewport.width)
    const frame = (await embed.locator('.provider-embed__frame').boundingBox())!
    expect(railBox.x).toBeGreaterThanOrEqual(frame.x + frame.width)
  })
})
