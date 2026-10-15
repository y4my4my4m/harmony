// Journey: personal emoji uploads (20261016100004_personal_emoji_uploads.sql).
//
// A user uploads a PNG in Settings › My emojis: it goes through the shared emoji pipeline to
// <profile>/<uuid>.png in the emojis bucket and create_my_emoji, lists with the count against
// max_personal_emojis_per_user, and shows in the composer picker's My Emoji group.
//
// An instance admin sets "Personal emojis per user" to 1 in Admin › Config › Federation while
// the user's settings page still holds the old limit. The user's first upload lands; the
// second passes the stale client check and is refused by enforce_personal_emoji_limit: the
// limit message shows, the count rereads 1 / 1, and the refused object is removed from storage.
//
// instance_config is snapshotted before and restored after: the admin form saves every key.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
// 1×1 PNG; the pipeline upscales pixel art to 128×128 before upload.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let uploader: SpecUser
let limited: SpecUser
let staff: SpecUser
let server: SeededServer
let limitedServer: SeededServer
let configSnapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []

async function removePersonalEmojis(user: SpecUser | undefined) {
  if (!user) return
  await admin.from('emojis').delete().eq('scope', 'user').eq('uploader', user.id)
  const { data } = await admin.storage.from('emojis').list(user.id)
  if (data?.length) await admin.storage.from('emojis').remove(data.map((o) => `${user.id}/${o.name}`))
}

test.beforeAll(async () => {
  const { data, error } = await admin.from('instance_config').select('config_key, config_value, description')
  if (error || !data) throw new Error(`snapshot instance_config: ${error?.message}`)
  configSnapshot = data
  uploader = await createUser(admin, 'pemu')
  limited = await createUser(admin, 'peml')
  staff = await createUser(admin, 'pema')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(`promote ${staff.username}: ${promoteError.message}`)
  server = await seedServer(admin, uploader, `Personal Emoji ${uploader.username}`)
  limitedServer = await seedServer(admin, limited, `Emoji Limit ${limited.username}`)
})

test.afterAll(async () => {
  const keys = new Set(configSnapshot.map((row) => row.config_key))
  const { data: now } = await admin.from('instance_config').select('config_key')
  const added = (now ?? []).map((row) => row.config_key).filter((key) => !keys.has(key))
  if (added.length) await admin.from('instance_config').delete().in('config_key', added)
  if (configSnapshot.length) await admin.from('instance_config').upsert(configSnapshot, { onConflict: 'config_key' })
  for (const user of [uploader, limited, staff]) {
    await removePersonalEmojis(user)
    await deleteUser(admin, user)
  }
})

async function personalLimit(): Promise<number> {
  const { data } = await admin.rpc('personal_emoji_limit')
  return Number(data)
}

async function openMyEmojis(page: Page) {
  await page.locator('[data-region="user"]').getByRole('button', { name: 'Settings' }).click()
  await page.waitForURL(/\/settings/)
  await page.locator('.settings-sidebar').getByText('My emojis', { exact: true }).click()
  await page.waitForURL(/\/settings\/emojis/)
  const section = page.getByTestId('my-emojis')
  await expect(section.getByTestId('emoji-count')).toBeVisible({ timeout: 15000 })
  return section
}

async function upload(page: Page, name: string) {
  await page.getByTestId('my-emojis').getByTestId('emoji-upload-input').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: PNG,
  })
}

test('a user uploads a personal emoji; it lists with the count and joins the picker', async ({ page }) => {
  test.setTimeout(180_000)
  const limit = await personalLimit()
  await signIn(page, uploader)
  await openChannel(page, server.id, server.generalChannelId)

  const section = await openMyEmojis(page)
  await expect(section.getByTestId('emoji-count')).toHaveText(`0 / ${limit}`)
  await expect(section).toContainText('You have no personal emojis yet.')
  await expect(section.getByText('Formats: PNG, GIF, WebP, APNG, JPEG.')).toBeVisible()

  await upload(page, 'sparkle.png')
  await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Emoji "sparkle" uploaded' })).toBeVisible({ timeout: 20000 })
  const item = section.locator('.emoji-item').filter({ hasText: ':sparkle:' })
  await expect(item).toBeVisible()
  await expect(item.locator('.emoji-badge')).toHaveCount(0)
  await expect(item).toContainText('not used yet')
  await expect(item.locator('img')).toHaveJSProperty('complete', true)
  expect(await item.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await expect(section.getByTestId('emoji-count')).toHaveText(`1 / ${limit}`)
  await expectNoAxeViolations(page, { include: '[data-testid="my-emojis"]', label: 'settings/emojis upload' })

  const { data: rows } = await admin
    .from('emojis')
    .select('name, url, scope, server_id, domain, is_ai_generated, file_size')
    .eq('uploader', uploader.id)
  expect(rows).toHaveLength(1)
  expect(rows![0]).toMatchObject({ name: 'sparkle', scope: 'user', server_id: null, domain: null, is_ai_generated: false })
  expect(rows![0].url).toMatch(new RegExp(`/storage/v1/object/public/emojis/${uploader.id}/[0-9a-f-]{36}\\.png$`))
  expect(rows![0].file_size).toBeGreaterThan(0)

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chat/${server.id}`))
  await page.locator('[data-testid="message-input"] button[aria-label="Emoji picker"]:visible').first().click()
  const picker = page.locator('.emoji-picker-content')
  await expect(picker).toBeVisible({ timeout: 15000 })
  const mine = picker.locator('.emoji-section').filter({ has: page.locator('h3.section-title', { hasText: 'My Emoji' }) })
  await mine.scrollIntoViewIfNeeded()
  await expect(mine.locator('button[aria-label=":sparkle:"]')).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden({ timeout: 5000 })
})

test('an admin limits personal emojis to 1; the second upload is refused with the limit message', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const limit = await personalLimit()
  await signIn(page, limited)
  await openChannel(page, limitedServer.id, limitedServer.generalChannelId)
  const section = await openMyEmojis(page)
  await expect(section.getByTestId('emoji-count')).toHaveText(`0 / ${limit}`)

  await test.step('the admin saves Personal emojis per user = 1', async () => {
    const context = await browser.newContext()
    try {
      const adminPage = await context.newPage()
      await signIn(adminPage, staff)
      await adminPage.goto('/admin?tab=config')
      await adminPage.locator('.config-tab-btn', { hasText: 'Federation' }).click()
      const field = adminPage.getByLabel('Personal emojis per user')
      await expect(field).toHaveValue(String(limit), { timeout: 20000 })
      await expect(adminPage.locator('#max-personal-emojis-hint')).toContainText('0 turns personal emojis off')
      await field.fill('1')
      await adminPage.locator('.config-section').getByRole('button', { name: 'Save changes' }).click()
      await expect(adminPage.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Configuration saved' })).toBeVisible({ timeout: 20000 })
    } finally {
      await context.close()
    }
    await expect.poll(personalLimit).toBe(1)
  })

  await test.step('the first upload lands', async () => {
    await upload(page, 'first.png')
    await expect(section.locator('.emoji-item').filter({ hasText: ':first:' })).toBeVisible({ timeout: 20000 })
  })

  const refusal = page.locator('.Vue-Toastification__toast--error').filter({ hasText: 'Maximum number of emojis reached (1)' })

  await test.step('the second is refused by the server and the count rereads the limit', async () => {
    await upload(page, 'second.png')
    await expect(refusal).toBeVisible({ timeout: 20000 })
    await expect(section.getByTestId('emoji-count')).toHaveText('1 / 1', { timeout: 10000 })
    await expect(section.locator('.emoji-item')).toHaveCount(1)
    const { data: rows } = await admin.from('emojis').select('name').eq('uploader', limited.id)
    expect(rows?.map((r) => r.name)).toEqual(['first'])
    await expect.poll(async () => (await admin.storage.from('emojis').list(limited.id)).data?.length).toBe(1)
  })

  await test.step('a third attempt is refused before it uploads', async () => {
    await refusal.click()
    await expect(refusal).toHaveCount(0, { timeout: 10000 })
    await upload(page, 'third.png')
    await expect(refusal).toBeVisible({ timeout: 10000 })
    expect((await admin.storage.from('emojis').list(limited.id)).data?.length).toBe(1)
  })
})
