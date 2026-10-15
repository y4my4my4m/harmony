// Journey: stored link previews as a reader sees them. A preview whose page could not be read
// (flagged failed, or stored earlier with the error as its description) shows no card; a link
// that answered with a video (embed-fixer sites) plays as a video; a page with an og:video
// shows its player in the card. A link straight to a video or GIF file shows that file once:
// its preview, which answers with the same file, rendered a second player beside the inline
// one. A Wikipedia article is a card with its lead text, also when its preview was stored
// media-only (Wikimedia keeps still photos as GIF, which read as a GIF page).
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
// Discord CDN links carry signed query parameters and end in "&".
const CDN_CLIP = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=6ad0146a&is=6acec2ea&hm=cc41&'
const CDN_GIF = 'https://media.example/dance.gif'
const WIKI_STORED = 'https://en.wikipedia.org/wiki/Moustapha_Akkad'
const WIKI = 'https://en.m.wikipedia.org/wiki/The_Message_(1976_film)'
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
  await post(CDN_CLIP, 'cdnclip', payload(CDN_CLIP, {
    title: 'cdn.discordapp.com', siteName: 'cdn.discordapp.com', mediaOnly: true, video: { url: CDN_CLIP, type: 'video/mp4' },
  }))
  await post(CDN_GIF, 'cdngif', payload(CDN_GIF, { title: 'media.example', mediaOnly: true, image: CDN_GIF }))
  await post(WIKI_STORED, 'storedwp', payload(WIKI_STORED, { title: 'Moustapha Akkad - Wikipedia', mediaOnly: true, image: VIDEO }))
  await post(WIKI, 'wparticle', payload(WIKI, {
    title: 'The Message (1976 film)', siteName: 'Wikipedia', image: VIDEO,
    description: 'The Message is a 1976 epic historical drama film directed by Moustapha Akkad.',
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
  // A player, not a looping GIF: Harmony's controls are over it.
  await expect(row('reel').getByTestId('video-controls')).toHaveCount(1)
  await expect(row('reel').locator('.provider-embed')).toHaveCount(0)

  const card = row('tweet').locator('.link-embed-card')
  await expect(card).toContainText('someone (@someone)')
  await expect(card).toContainText('vxTwitter / fixvx')
  await expect(card.locator('video')).toHaveAttribute('src', VIDEO)
  await expect(card.getByTestId('video-controls')).toHaveCount(1)

  await expect(row('cdnclip').locator('video')).toHaveCount(1)
  await expect(row('cdnclip').locator('video')).toHaveAttribute('src', CDN_CLIP)
  await expect(row('cdngif').locator('img.content-image')).toHaveCount(1)

  await expect(row('storedwp').locator('.link-embed-card')).toContainText('Moustapha Akkad - Wikipedia')
  await expect(row('storedwp').locator('img.content-image')).toHaveCount(0)
  const wiki = row('wparticle').locator('.link-embed-card')
  await expect(wiki).toContainText('The Message (1976 film)')
  await expect(wiki).toContainText('epic historical drama')
  await expect(wiki).toContainText('Wikipedia')
  await expect(wiki).not.toHaveClass(/link-embed-card--media/)
  await expect(row('wparticle').locator('img.content-image')).toHaveCount(0)
})
