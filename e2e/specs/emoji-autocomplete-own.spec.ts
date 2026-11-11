// Journey: `:name` in the composer offers the instance's emoji and the member's own in a session
// that has not opened an emoji picker (composables/useAutoSuggest.ts loadOwnEmojis). Those two
// groups are not server emoji; only the pickers loaded them, so the list held server emoji alone
// until a picker had been opened once.
//
// A member types a prefix both emoji share: both are listed. The instance emoji is picked, drawn
// in the editor and sent; the stored part is that emoji. The personal one follows.

import crypto from 'node:crypto'
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

// 16x16 opaque PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR42mP8z8AARMQBxlGF1FUIAMJVAf8zYy5CAAAAAElFTkSuQmCC',
  'base64',
)
const admin = adminClient()
const tag = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
const prefix = `ac${tag}`
const instance = { name: `${prefix}inst`, url: `https://emoji.e2e.test/${prefix}-inst.png`, id: '' }
const personal = { name: `${prefix}mine`, url: `https://emoji.e2e.test/${prefix}-mine.png`, id: '' }
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'eacown')
  server = await seedServer(admin, user, `Autocomplete ${user.username.slice(-6)}`)
  const rows = [
    { target: instance, row: { name: instance.name, url: instance.url, scope: 'instance' } },
    { target: personal, row: { name: personal.name, url: personal.url, scope: 'user', uploader: user.id } },
  ]
  for (const { target, row } of rows) {
    const { data, error } = await admin.from('emojis').insert(row).select('id').single()
    if (error || !data) throw new Error(`emoji ${row.name}: ${error?.message}`)
    target.id = data.id
  }
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', [instance.id, personal.id].filter(Boolean))
  await deleteUser(admin, user)
})

const editor = (page: Page) => page.locator('[data-region="composer"]').locator('[contenteditable="true"]').first()

/** Sends the draft; the id of the stored emoji part. */
async function send(page: Page, marker: string): Promise<string | undefined> {
  await page.keyboard.type(` ${marker}`)
  await page.keyboard.press('Enter')
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: marker }).last()
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  const id = await row.getAttribute('data-message-id')
  const { data } = await admin.from('messages').select('content').eq('id', id!).single()
  const part = (data!.content as Array<{ type: string; emoji?: { id?: string } }>).find((p) => p.type === 'emoji')
  return part?.emoji?.id
}

test('typing :name offers instance and personal emoji before any picker was opened', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(editor(page)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.media-picker-popup')).toHaveCount(0)

  await editor(page).click()
  await page.keyboard.type(`:${prefix}`)
  const options = page.locator('[role="option"]').filter({ hasText: prefix })
  await expect(options).toHaveCount(2, { timeout: 15000 })
  await options.filter({ hasText: instance.name }).click()
  await expect(editor(page).locator('.editor-emoji img')).toHaveAttribute('src', instance.url)
  expect(await send(page, `instance ${tag}`)).toBe(instance.id)

  await editor(page).click()
  await page.keyboard.type(`:${personal.name}`)
  const mine = page.locator('[role="option"]').filter({ hasText: personal.name })
  await expect(mine).toHaveCount(1, { timeout: 15000 })
  await mine.click()
  await expect(editor(page).locator('.editor-emoji img')).toHaveAttribute('src', personal.url)
  expect(await send(page, `personal ${tag}`)).toBe(personal.id)
  await expect(page.locator('.media-picker-popup')).toHaveCount(0)
})
