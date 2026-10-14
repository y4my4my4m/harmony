// Journey: music links play in their service's own player. A SoundCloud track whose preview
// failed, a Spotify track with a stored preview, and an Apple Music song never previewed at
// all each render that service's embed player, chosen from the link, instead of a card. On a
// web origin the player is framed directly; the relay page at /embed-player.html (used from
// tauri://) frames only https players on its allowlisted hosts.
//
// Provider players are answered by routes; the stack reaches no music service.

import { test, expect } from '@playwright/test'
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

const SOUNDCLOUD = 'https://soundcloud.com/someone/night-drive'
const SPOTIFY = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
const APPLE = 'https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378615'
const PLAYER_HOSTS = ['https://w.soundcloud.com/**', 'https://open.spotify.com/**', 'https://embed.music.apple.com/**']

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const payload = (url: string, over: Record<string, unknown>) => ({
  cacheKey: `x:${url}`, url, normalizedUrl: url, provider: 'generic',
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
})

async function post(label: string, url: string, embed: Record<string, unknown> | null) {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `${label} ` }, { type: 'url', url }],
    metadata: embed ? { embeds: { [url]: embed } } : {},
  })
  if (error) throw new Error(`message: ${error.message}`)
}

test.beforeAll(async () => {
  user = await createUser(admin, 'music')
  server = await seedServer(admin, user, `Music ${user.username}`)
  await post('cloud', SOUNDCLOUD, payload(SOUNDCLOUD, { title: SOUNDCLOUD, failed: true }))
  await post('spot', SPOTIFY, payload(SPOTIFY, { provider: 'spotify', title: 'Blinding Lights', siteName: 'Spotify' }))
  await post('apple', APPLE, null)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('music links render their service player, not a card', async ({ page }) => {
  test.setTimeout(120_000)
  for (const host of PLAYER_HOSTS) {
    await page.route(host, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' }))
  }
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const row = (label: string) => messageList(page).locator('.message-item').filter({ hasText: `${label} ` })
  await expect(row('apple')).toBeVisible({ timeout: 30000 })

  const cases = [
    { label: 'cloud', provider: 'soundcloud', src: /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fsoundcloud\.com%2Fsomeone%2Fnight-drive/ },
    { label: 'spot', provider: 'spotify', src: /^https:\/\/open\.spotify\.com\/embed\/track\/4uLU6hMCjMI75M1A2tKUQC\?/ },
    { label: 'apple', provider: 'apple-music', src: 'https://embed.music.apple.com/us/album/blinding-lights/1499378108?i=1499378615' },
  ]
  for (const c of cases) {
    await test.step(`${c.provider} plays in its player`, async () => {
      const embed = row(c.label).getByTestId('music-embed')
      await embed.scrollIntoViewIfNeeded()
      await expect(embed).toHaveAttribute('data-provider', c.provider)
      await expect(embed.locator('iframe')).toHaveAttribute('src', c.src)
      await expect(embed).toHaveClass(/is-loaded/, { timeout: 15000 })
      await expect(row(c.label).locator('.link-embed-card')).toHaveCount(0)
    })
  }
})

test('the relay page frames allowlisted https players only', async ({ page }) => {
  const player = 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=harmony'
  await page.route('https://open.spotify.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }))

  await page.goto(`/embed-player.html?src=${encodeURIComponent(player)}`)
  await expect(page.locator('#root iframe')).toHaveAttribute('src', player)

  for (const refused of [
    'https://evil.example/embed/track/x',
    'http://open.spotify.com/embed/track/x',
    'https://open.spotify.com/track/x',
  ]) {
    await page.goto(`/embed-player.html?src=${encodeURIComponent(refused)}`)
    await expect(page.locator('#root iframe')).toHaveCount(0)
  }
})
