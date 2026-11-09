// Journey: Appearance > Animate custom emoji. Off, a message's animated emoji shows its first
// frame, for this viewer alone; on, it animates again. The setting survives a reload.

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

// 2x2 GIF89a, two frames.
const GIF = Buffer.from(
  'R0lGODlhAgACAIABAP8AAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCgABACwAAAAAAgACAAACAoRRADs=',
  'base64',
)
const EMOJI_URL = 'https://emoji.e2e.test/party.gif'

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let emojiId = ''

test.beforeAll(async () => {
  user = await createUser(admin, 'aes')
  server = await seedServer(admin, user, `Animate ${user.username.slice(-6)}`)
  const name = `party${user.username.slice(-6)}`
  const { data, error } = await admin.from('emojis')
    .insert({ name, url: EMOJI_URL, server_id: server.id, scope: 'server', uploader: user.id })
    .select('id').single()
  if (error || !data) throw new Error(`emoji: ${error?.message}`)
  emojiId = data.id
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'dance ' }, { type: 'emoji', emoji: { id: emojiId, name, url: EMOJI_URL } }],
  })
  if (posted.error) throw new Error(posted.error.message)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, user)
})

const emoji = (page: Page): Locator => messageList(page).locator('img.emoji-icon').first()

async function setAnimate(page: Page, on: boolean) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  const toggle = page.getByRole('switch', { name: 'Animate custom emoji' })
  await expect(toggle).toBeVisible({ timeout: 30000 })
  if ((await toggle.getAttribute('aria-checked')) === String(on)) return
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  const written = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/profiles') && r.request().method() === 'PATCH', { timeout: 15000 })
  await page.getByTestId('appearance-save-bar').getByRole('button', { name: 'Save changes' }).click()
  await written
}

test('off draws the first frame; on animates again; the choice survives a reload', async ({ page }) => {
  test.setTimeout(150_000)
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/gif',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: GIF,
    }))
  await signIn(page, user)

  await openChannel(page, server.id, server.generalChannelId)
  await expect(emoji(page)).toHaveAttribute('src', EMOJI_URL, { timeout: 30000 })

  await setAnimate(page, false)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(emoji(page)).toHaveAttribute('src', /^blob:/, { timeout: 30000 })
  await expect.poll(() => emoji(page).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2)

  await page.reload()
  await expect(emoji(page)).toHaveAttribute('src', /^blob:/, { timeout: 30000 })

  await setAnimate(page, true)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(emoji(page)).toHaveAttribute('src', EMOJI_URL, { timeout: 30000 })
})

test('an emoji from a host without CORS keeps showing', async ({ page }) => {
  test.setTimeout(120_000)
  // route.fulfill adds Access-Control-Allow-Origin to a request with an Origin header, so a fulfilled
  // response cannot stand for such a host. A refused CORS read and an abort both end in the image's
  // error event.
  await page.route('https://emoji.e2e.test/**', async (route) => {
    if (await route.request().headerValue('origin')) await route.abort()
    else await route.fulfill({ status: 200, contentType: 'image/gif', body: GIF })
  })
  await signIn(page, user)
  await setAnimate(page, false)
  await openChannel(page, server.id, server.generalChannelId)
  await expect.poll(() => emoji(page).evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 30000 }).toBe(2)
  await expect(emoji(page)).toHaveAttribute('src', EMOJI_URL)
  await setAnimate(page, true)
})
