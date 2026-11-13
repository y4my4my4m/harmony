// Journey: emoji shorthand as Discord has it. Typing `:P` beside a custom emoji whose name
// starts with p lists the tongue emoji first, and Enter inserts it; the list held the custom
// emoji alone. `:')`, `:'D` and `8-)` are sent as 🥲, 😂 and 😎; `:')` stayed text.
// `:sunglasses:` and `:dog:` are 😎 and 🐶; they were 🕶️ and 🐕.

import crypto from 'node:crypto'
import { test, expect, type Locator, type Page } from '@playwright/test'
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
const custom = { name: `pp${tag}`, url: `https://emoji.e2e.test/pp-${tag}.png`, id: '' }
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'emshort')
  server = await seedServer(admin, user, `Shorthand ${user.username.slice(-6)}`)
  const { data, error } = await admin.from('emojis')
    .insert({ name: custom.name, url: custom.url, scope: 'user', uploader: user.id }).select('id').single()
  if (error || !data) throw new Error(`emoji ${custom.name}: ${error?.message}`)
  custom.id = data.id
})

test.afterAll(async () => {
  if (custom.id) await admin.from('emojis').delete().eq('id', custom.id)
  await deleteUser(admin, user)
})

const editor = (page: Page) => page.locator('[data-region="composer"]').locator('[contenteditable="true"]').first()
const options = (page: Page) => page.locator('#auto-suggest-listbox').getByRole('option')

/** Sends the draft with `marker` appended; the stored message's row. */
async function send(page: Page, marker: string): Promise<Locator> {
  await page.keyboard.type(` ${marker}`)
  await expect(page.locator('#auto-suggest-listbox')).toHaveCount(0)
  await page.keyboard.press('Enter')
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: marker }).last()
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return row
}

const emoji = (row: Locator, unicode: string) => row.locator(`img.inline-emoji[alt="${unicode}"]`)

test('shorthand resolves as on Discord in the suggestions, on send and by name', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(editor(page)).toBeVisible({ timeout: 30000 })

  await test.step(':P lists the tongue emoji ahead of a custom emoji starting with p', async () => {
    await editor(page).click()
    await page.keyboard.type(':P', { delay: 50 })
    await expect(options(page).filter({ hasText: custom.name })).toHaveCount(1, { timeout: 15000 })
    await expect(options(page).first()).toContainText('stuck_out_tongue', { timeout: 15000 })
    await page.keyboard.press('Enter')
    await expect(page.locator('#auto-suggest-listbox')).toHaveCount(0)
    const row = await send(page, `tongue ${tag}`)
    await expect(emoji(row, '😛')).toHaveCount(1)
    await expect(row).not.toContainText(custom.name)
  })

  await test.step('Discord emoticons convert on send', async () => {
    await editor(page).click()
    await page.keyboard.type(`:') and :'D and 8-)`, { delay: 30 })
    const row = await send(page, `faces ${tag}`)
    await expect(emoji(row, '🥲')).toHaveCount(1)
    await expect(emoji(row, '😂')).toHaveCount(1)
    await expect(emoji(row, '😎')).toHaveCount(1)
  })

  await test.step(':sunglasses: and :dog: are the emoji Discord gives those names', async () => {
    await editor(page).click()
    await page.keyboard.type(':sunglasses: :dog:', { delay: 30 })
    const row = await send(page, `names ${tag}`)
    await expect(emoji(row, '😎')).toHaveCount(1)
    await expect(emoji(row, '🐶')).toHaveCount(1)
    await expect(emoji(row, '🕶️')).toHaveCount(0)
    await expect(emoji(row, '🐕')).toHaveCount(0)
  })
})
