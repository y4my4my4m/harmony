// Journey: an announcement shows the instance's custom emoji for :name:, outside code, and the
// list in User settings → Announcements shows it too.
//
// Announcements are instance-wide: this one ends 15 minutes after it starts and is deleted
// afterwards, with its emoji.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const IMAGE_URL = `${process.env.BASE_URL || 'http://localhost:5173'}/default_server.webp`
let user: SpecUser
let announcementId = ''
let emojiId = ''
const tag = Date.now().toString(36)
const NAME = `annmoji${tag}`
const TITLE = `Emoji notice ${tag}`

test.beforeAll(async () => {
  user = await createUser(admin, 'annem')
  const emoji = await admin.from('emojis')
    .insert({ name: NAME, url: IMAGE_URL, server_id: null, domain: null, scope: 'instance' })
    .select('id').single()
  if (emoji.error || !emoji.data) throw new Error(`emoji: ${emoji.error?.message}`)
  emojiId = emoji.data.id
  const { data, error } = await admin
    .from('instance_announcements')
    .insert({
      title: TITLE,
      content: `<p>Launch day :${NAME}: :unknown${tag}:</p><p><code>:${NAME}:</code></p>`,
      is_active: true,
      show_popup: true,
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`announcement: ${error?.message}`)
  announcementId = data.id
})

test.afterAll(async () => {
  if (announcementId) await admin.from('instance_announcements').delete().eq('id', announcementId)
  if (emojiId) await admin.from('emojis').delete().eq('id', emojiId)
  await deleteUser(admin, user)
})

test('an announcement shows the instance\'s custom emoji', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)

  const dialog = page.getByRole('dialog', { name: 'Announcements' })
  await expect(dialog).toBeVisible({ timeout: 30000 })
  const content = dialog.locator('.announcement-content').filter({ hasText: 'Launch day' })

  await test.step('the shortcode is the emoji image, loaded', async () => {
    const emoji = content.locator(`img.inline-emoji[alt=":${NAME}:"]`)
    await expect(emoji).toHaveCount(1, { timeout: 30000 })
    await expect(emoji).toHaveAttribute('src', IMAGE_URL)
    await expect.poll(() => emoji.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
  })

  await test.step('an unknown shortcode and one in code stay text', async () => {
    await expect(content).toContainText(`:unknown${tag}:`)
    await expect(content.locator('code')).toHaveText(`:${NAME}:`)
  })

  await test.step('the announcements list in settings shows it too', async () => {
    await dialog.getByTestId('announcement-mark-read').click()
    await expect(dialog).toBeHidden()
    await page.goto('/settings/announcements')
    // Read announcements are under All.
    await page.getByRole('tab', { name: /^All\b/ }).click()
    const listed = page.locator('.announcement-content').filter({ hasText: 'Launch day' })
    await expect(listed.locator(`img.inline-emoji[alt=":${NAME}:"]`)).toHaveCount(1, { timeout: 30000 })
  })
})
