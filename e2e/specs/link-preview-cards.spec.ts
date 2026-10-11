// Journey: stored link previews as a reader sees them. A preview whose page could not be read
// (flagged failed, or stored earlier with the error as its description) shows no card; a link
// that answered with a video (embed-fixer sites) plays as a video; a page with an og:video
// shows its player in the card.
//
// The stack runs no federation backend: previews are written into message metadata as the
// backend's enrichment writes them.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const FAILED = 'https://slow.example/'
const LEGACY = 'https://legacy.example/'
const REEL = 'https://www.kkinstagram.com/p/DdEJpNJIV_e/'
const TWEET = 'https://vxtwitter.com/someone/status/1'
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
// The dev server's own asset stands in for the video file.
const VIDEO = new URL('/default_avatar.webp', BASE_URL).href

const payload = (url: string, over: Record<string, unknown>) => ({
  cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'generic',
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
})

async function post(url: string, label: string, embed: Record<string, unknown>) {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `${label} ` }, { type: 'url', url }],
    metadata: { embeds: { [url]: embed } },
  })
  if (error) throw new Error(`message: ${error.message}`)
}

test.beforeAll(async () => {
  user = await createUser(admin, 'lpc')
  server = await seedServer(admin, user, `Previews ${user.username}`)
  await post(FAILED, 'failed', payload(FAILED, { title: FAILED, siteName: 'slow.example', failed: true }))
  await post(LEGACY, 'legacy', payload(LEGACY, { title: LEGACY, siteName: 'legacy.example', description: 'Blocked protocol: http:' }))
  await post(REEL, 'reel', payload(REEL, { title: 'www.kkinstagram.com', mediaOnly: true, video: { url: VIDEO, type: 'video/mp4' } }))
  await post(TWEET, 'tweet', payload(TWEET, {
    title: 'someone (@someone)', description: 'look at this', siteName: 'vxTwitter / fixvx',
    image: VIDEO, video: { url: VIDEO, type: 'video/mp4' },
  }))
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('failed previews show no card; video answers and og:video play', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const list = page.locator('[data-testid="message-list"]')
  const row = (label: string) => list.locator('.message-item').filter({ hasText: `${label} ` })

  await expect(row('tweet')).toBeVisible({ timeout: 30000 })

  await expect(row('failed').locator('.provider-embed')).toHaveCount(0)
  await expect(row('legacy').locator('.provider-embed')).toHaveCount(0)
  await expect(row('legacy')).not.toContainText('Blocked protocol')

  await expect(row('reel').locator('video')).toHaveAttribute('src', VIDEO)
  await expect(row('reel').locator('video')).toHaveAttribute('controls', '')
  await expect(row('reel').locator('.provider-embed')).toHaveCount(0)

  const card = row('tweet').locator('.link-embed-card')
  await expect(card).toContainText('someone (@someone)')
  await expect(card).toContainText('vxTwitter / fixvx')
  await expect(card.locator('video')).toHaveAttribute('src', VIDEO)
})
