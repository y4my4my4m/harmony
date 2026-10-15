// Journey: rich embeds size to their media. A YouTube Short's card narrows to its 9:16
// frame; a link preview whose content is an image or a video stacks the media above the
// text at its own aspect and the card narrows to it, instead of a 100px thumbnail beside
// the text. The embed header carries icon buttons named for screen readers; the close
// button hides the preview and a show button brings it back.
//
// The stack runs no federation backend: previews are written into message metadata as the
// backend's enrichment writes them.

import { test, expect, type Locator } from '@playwright/test'
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
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const width = async (l: Locator) => (await l.boundingBox())?.width ?? 0

test('embeds size to their media and the header uses named icon buttons', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const row = (label: string) => messageList(page).locator('.message-item').filter({ hasText: `${label} ` })
  await expect(row('clip').locator('.link-embed-card')).toBeVisible({ timeout: 30000 })

  await test.step('a Short narrows its card to the 9:16 frame', async () => {
    const card = row('short').locator('.provider-embed')
    const media = card.locator('.provider-embed__media')
    await expect(media).toBeVisible()
    const cardWidth = await width(card)
    expect(cardWidth).toBeLessThanOrEqual(322)
    expect(cardWidth - (await width(media))).toBeLessThanOrEqual(2)
    expect(await width(row('watch').locator('.provider-embed'))).toBeGreaterThan(400)
  })

  await test.step('the header buttons are icons with names; close hides and show restores', async () => {
    const card = row('short').locator('.provider-embed')
    const header = card.locator('.provider-embed__header')
    await expect(header.getByRole('button', { name: 'Open' })).toBeVisible()
    const hide = header.getByRole('button', { name: 'Hide' })
    await expect(hide).toHaveText('')
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    expect((await header.boundingBox())?.height ?? 0).toBeLessThanOrEqual(36)

    await hide.click()
    await expect(card.locator('.provider-embed__media')).toHaveCount(0)
    const show = header.getByRole('button', { name: 'Show' })
    await expect(show).toHaveAttribute('aria-expanded', 'false')
    await show.click()
    await expect(card.locator('.provider-embed__media')).toBeVisible()
  })

  await test.step('an image preview stacks its image and narrows to it', async () => {
    const card = row('tall').locator('.provider-embed')
    const image = card.locator('.link-embed-card__media img')
    await expect(card.locator('.link-embed-card--media')).toBeVisible()
    await expect(image).toBeVisible()
    const imageBox = await image.boundingBox()
    expect(imageBox!.height).toBeGreaterThan(imageBox!.width * 1.5)
    expect(await width(card)).toBeLessThan(260)
  })

  await test.step('a video preview plays at its own size, not as a thumbnail', async () => {
    const card = row('clip').locator('.provider-embed')
    const video = card.locator('.link-embed-card__media video')
    await expect(card.locator('.link-embed-card--media')).toBeVisible()
    await expect(video).toHaveAttribute('src', PORTRAIT)
    await expect.poll(async () => (await video.boundingBox())?.height ?? 0, { timeout: 10000 }).toBeGreaterThan(300)
    expect(await width(card)).toBeLessThan(260)
    await expect(card).toContainText('portrait clip')
  })
})
