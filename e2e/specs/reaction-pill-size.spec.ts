// Journey: a message's reaction pills have Discord's measurements. Discord's web client
// stylesheet (17256.2f23007cdb83038c.css, .reaction_f8896c, read 2026-10-27) gives a 1px
// border, 2px 6px padding, a 20px emoji with 2px vertical margin and the count in 14px
// semibold 6px after it: a 30px pill. A unicode (drawn as the emoji pack's SVG) and a server
// emoji reaction are measured, and the add button beside them is as tall as the pills.

import { test, expect, type Page } from '@playwright/test'
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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let emojiId = ''
let objectPath = ''

test.beforeAll(async () => {
  user = await createUser(admin, 'rpill')
  server = await seedServer(admin, user, `Pills ${user.username.slice(-6)}`)
  objectPath = `${user.id}/pill_${user.username.slice(-6)}.png`
  const { error: uploadError } = await admin.storage.from('emojis').upload(objectPath, PNG, { contentType: 'image/png', upsert: true })
  if (uploadError) throw new Error(`emoji upload: ${uploadError.message}`)
  const url = admin.storage.from('emojis').getPublicUrl(objectPath).data.publicUrl
  const { data: emoji, error: emojiError } = await admin
    .from('emojis')
    .insert({ name: `pill_${user.username.slice(-6)}`, url, server_id: server.id, scope: 'server', uploader: user.id })
    .select('id')
    .single()
  if (emojiError || !emoji) throw new Error(`emoji: ${emojiError?.message}`)
  emojiId = emoji.id

  const { data: message, error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: user.id, content: [{ type: 'text', text: 'measure my reactions' }] })
    .select('id')
    .single()
  if (error || !message) throw new Error(`message: ${error?.message}`)
  const { error: reactionError } = await admin.from('reactions').insert([
    { message_id: message.id, user_id: user.id, custom_emoji_content: '👍' },
    { message_id: message.id, user_id: user.id, emoji_id: emojiId },
  ])
  if (reactionError) throw new Error(`reactions: ${reactionError.message}`)
})

test.afterAll(async () => {
  if (emojiId) await admin.from('emojis').delete().eq('id', emojiId)
  if (objectPath) await admin.storage.from('emojis').remove([objectPath])
  await deleteUser(admin, user)
})

const row = (page: Page) => page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'measure my reactions' })

type Box = { x: number; y: number; width: number; height: number }
const box = async (page: Page, selector: string, nth = 0): Promise<Box> => {
  const b = await row(page).locator(selector).nth(nth).boundingBox()
  expect(b, selector).toBeTruthy()
  return b!
}

test('reaction pills measure as Discord’s: 30px tall, 20px emoji, 14px semibold count', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const pills = row(page).locator('.message-reactions .reaction')
  await expect(pills).toHaveCount(2, { timeout: 30000 })
  await expect(row(page).locator('.reaction img.reaction-emoji')).toHaveCount(2, { timeout: 15000 })

  for (let i = 0; i < 2; i++) {
    await test.step(`pill ${i + 1}`, async () => {
      const pill = pills.nth(i)
      const p = (await pill.boundingBox())!
      expect(Math.round(p.height)).toBe(30)
      const emoji = pill.locator('.native-emoji, img.reaction-emoji').first()
      const e = (await emoji.boundingBox())!
      expect(Math.round(e.height)).toBe(20)
      const count = pill.locator('.reaction-count')
      await expect(count).toHaveCSS('font-size', '14px')
      await expect(count).toHaveCSS('font-weight', '600')
      const c = (await count.boundingBox())!
      expect(Math.round(c.x - (e.x + e.width))).toBe(6)
      // 1px border + 6px padding before the emoji.
      expect(Math.round(e.x - p.x)).toBe(7)
    })
  }

  await test.step('the server emoji and the unicode emoji are drawn 20px square', async () => {
    for (const selector of ['.reaction img[alt^=":pill_"]', '.reaction img[alt="thumbs up"]']) {
      const img = await box(page, selector)
      expect(Math.round(img.width), selector).toBe(20)
      expect(Math.round(img.height), selector).toBe(20)
    }
  })

  await test.step('the add button is as tall as the pills', async () => {
    const add = await box(page, '[data-testid="add-reaction-btn"]')
    expect(Math.round(add.height)).toBe(30)
  })
})
