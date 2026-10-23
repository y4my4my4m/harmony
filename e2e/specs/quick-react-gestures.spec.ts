// Journey: quick react has a switch per gesture. With a mouse, a double-click on empty space
// of a message reacts only while "Double-click to react" is on; on a touch screen, a double
// tap reacts only while "Double-tap to react" is on, and the dblclick the browser sends after
// it is not taken for a double-click. Both switches are stored on the device.

import { devices, test, expect, type Page } from '@playwright/test'
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
  user = await createUser(admin, 'qreact')
  server = await seedServer(admin, user, `Quick ${user.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'react to me' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const row = (page: Page) => page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'react to me' })
const reactions = (page: Page) => row(page).locator('.message-reactions .reaction')

async function setSwitches(page: Page, values: { click: boolean; tap: boolean }) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  const click = page.getByRole('switch', { name: 'Double-click to react' })
  const tap = page.getByRole('switch', { name: 'Double-tap to react' })
  await expect(click).toBeVisible({ timeout: 30000 })
  for (const [sw, on] of [[click, values.click], [tap, values.tap]] as const) {
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click()
  }
  const bar = page.getByTestId('appearance-save-bar')
  if (await bar.isVisible()) {
    await bar.getByRole('button', { name: 'Save changes' }).click()
    await expect(bar).toBeHidden()
  }
  await openChannel(page, server.id, server.generalChannelId)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
}

/** A point on the message row right of its text, below the action bar. */
async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
  const box = (await row(page).boundingBox())!
  return { x: box.x + box.width * 0.75, y: box.y + box.height - 8 }
}

async function clearReactions() {
  await admin.from('reactions').delete().eq('user_id', user.id)
}

test.describe('with a mouse', () => {
  test('a double-click reacts only while its switch is on', async ({ page }) => {
    test.setTimeout(120_000)
    await clearReactions()
    await signIn(page, user)
    await setSwitches(page, { click: false, tap: true })
    const spot = await emptySpot(page)
    await page.mouse.dblclick(spot.x, spot.y)
    await page.waitForTimeout(1500)
    await expect(reactions(page)).toHaveCount(0)

    await setSwitches(page, { click: true, tap: false })
    const again = await emptySpot(page)
    await page.mouse.dblclick(again.x, again.y)
    await expect(reactions(page)).toHaveCount(1, { timeout: 15000 })
  })
})

test.describe('on a touch screen', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('a double tap reacts only while its switch is on', async ({ page }) => {
    test.setTimeout(120_000)
    await clearReactions()
    await signIn(page, user)
    await setSwitches(page, { click: true, tap: false })
    let spot = await emptySpot(page)
    await page.touchscreen.tap(spot.x, spot.y)
    await page.touchscreen.tap(spot.x, spot.y)
    await page.waitForTimeout(1500)
    await expect(reactions(page)).toHaveCount(0)

    await setSwitches(page, { click: false, tap: true })
    spot = await emptySpot(page)
    await page.touchscreen.tap(spot.x, spot.y)
    await page.touchscreen.tap(spot.x, spot.y)
    await expect(reactions(page)).toHaveCount(1, { timeout: 15000 })
  })
})
