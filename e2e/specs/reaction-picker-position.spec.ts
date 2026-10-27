// Journey: the reaction picker opens beside the button that opened it, the first time on a
// fresh page as every time after. Its emoji data loads on first open; the position must not
// wait for it.

import { test, expect, type Locator, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'rpp')
  server = await seedServer(admin, user, `Reactions ${user.username}`)
  const rows = Array.from({ length: 6 }, (_, i) => ({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `message ${i + 1}` }],
    created_at: new Date(Date.now() - (6 - i) * 60_000).toISOString(),
  }))
  const { error } = await admin.from('messages').insert(rows)
  if (error) throw new Error(`messages: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

type Box = { x: number; y: number; width: number; height: number }

/** Opens the picker from a message's hover toolbar; the button's box as it was when clicked. */
async function openPicker(page: Page, text: string): Promise<{ picker: Locator; button: Box }> {
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: text })
  await row.hover()
  const trigger = row.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'Add reaction', exact: true })
  const button = (await trigger.boundingBox())!
  await trigger.click()
  const picker = page.getByRole('dialog', { name: 'Add reaction' })
  await expect(picker).toBeVisible()
  return { picker, button }
}

async function gap(picker: Locator, b: Box) {
  // Measured once the first open's emoji data has loaded.
  await picker.page().waitForTimeout(1500)
  const p = (await picker.boundingBox())!
  return {
    // The picker opens to the left of the button and overlaps its row vertically.
    horizontal: Math.round(b.x - (p.x + p.width)),
    verticalOverlap: Math.round(Math.min(p.y + p.height, b.y + b.height) - Math.max(p.y, b.y)),
  }
}

test('the reaction picker opens beside its button on first open', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="message-list"]').getByText('message 6')).toBeVisible({ timeout: 30000 })

  const first = await openPicker(page, 'message 3')
  const firstGap = await gap(first.picker, first.button)
  await page.keyboard.press('Escape')
  await expect(first.picker).toBeHidden()

  const second = await openPicker(page, 'message 3')
  const secondGap = await gap(second.picker, second.button)

  expect(firstGap.verticalOverlap).toBeGreaterThan(0)
  expect(Math.abs(firstGap.horizontal)).toBeLessThan(40)
  expect(firstGap).toEqual(secondGap)
})
