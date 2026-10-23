// Journey: the reaction tooltip names a default emoji by its shortcode, as text, both while
// the reaction is on its way (the request is held) and once it is stored; never by the emoji
// character between colons. The reaction is added with quick react (double-click, thumbs up).

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

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'rlabel')
  server = await seedServer(admin, user, `Labels ${user.username.slice(-6)}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'label me' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const row = (page: Page) => page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'label me' })
const tooltipLabel = (page: Page) => page.locator('.reaction-tooltip .emoji-name')

test('a default emoji reaction is labelled :thumbs_up: before and after it is stored', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(row(page)).toBeVisible({ timeout: 30000 })

  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/reactions*', async (route) => {
    if (route.request().method() === 'POST') await held
    await route.fallback()
  })

  await test.step('while the reaction is on its way', async () => {
    const box = (await row(page).boundingBox())!
    await page.mouse.dblclick(box.x + box.width * 0.75, box.y + box.height - 8)
    const pill = row(page).locator('.message-reactions .reaction').first()
    await expect(pill).toBeVisible({ timeout: 10000 })
    await pill.hover()
    await expect(tooltipLabel(page)).toHaveText(':thumbs_up:', { timeout: 5000 })
  })

  await test.step('once it is stored', async () => {
    const stored = page.waitForResponse((r) => r.url().includes('/rest/v1/reactions') && r.request().method() === 'POST')
    release()
    expect((await stored).ok()).toBe(true)
    await page.mouse.move(0, 0)
    await page.reload()
    await expect(row(page)).toBeVisible({ timeout: 30000 })
    await row(page).locator('.message-reactions .reaction').first().hover()
    await expect(tooltipLabel(page)).toHaveText(':thumbs_up:', { timeout: 5000 })
  })
})
