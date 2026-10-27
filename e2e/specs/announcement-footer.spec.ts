// Journey: an announcement longer than the dialog keeps "Don't show again" in the dialog's
// footer, on screen without scrolling the announcement. The body scrolls under the fixed
// footer; the button marks the announcement read, so it stays away after a reload.
//
// Announcements are instance-wide: this one ends 15 minutes after it starts and is deleted
// afterwards.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let announcementId = ''
const TITLE = `Long notice ${Date.now().toString(36)}`

test.beforeAll(async () => {
  user = await createUser(admin, 'annft')
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: the instance moves to new hardware this weekend; expect short interruptions.`)
  const { data, error } = await admin
    .from('instance_announcements')
    .insert({
      title: TITLE,
      content: paragraphs.join('\n\n'),
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
  await deleteUser(admin, user)
})

test('"Don\'t show again" sits in the footer, visible without scrolling', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await signIn(page, user)

  const dialog = page.getByRole('dialog', { name: 'Announcements' })
  await expect(dialog).toBeVisible({ timeout: 30000 })
  await expect(dialog.getByRole('heading', { name: TITLE })).toBeVisible()
  const body = dialog.locator('.popup-body')

  await test.step('the announcement overflows the dialog body', async () => {
    const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(overflow).toBeGreaterThan(200)
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0)
  })

  // The control that marks the announcement read.
  const dismiss = dialog.getByTestId('announcement-mark-read')
  await test.step('the button is in the footer and on screen with the body unscrolled', async () => {
    await expect(dismiss).toHaveCount(1)
    await expect(dismiss).toBeInViewport({ ratio: 1 })
    await expect(dismiss).toHaveAccessibleName("Don't show again")
    await expect(dialog.getByTestId('announcement-footer').getByRole('button', { name: "Don't show again" })).toHaveCount(1)
    const d = (await dismiss.boundingBox())!
    const b = (await body.boundingBox())!
    expect(d.y).toBeGreaterThanOrEqual(b.y + b.height - 1)
  })

  await test.step('it marks the announcement read; a reload does not show it again', async () => {
    await dismiss.click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => {
      const { count } = await admin
        .from('announcement_reads')
        .select('id', { count: 'exact', head: true })
        .eq('announcement_id', announcementId)
        .eq('user_id', user.id)
      return count ?? 0
    }, { timeout: 15000 }).toBe(1)
    await page.reload()
    await page.waitForURL(/\/chat/, { timeout: 30000 })
    await page.waitForTimeout(2000)
    await expect(page.getByTestId('announcement-overlay')).toHaveCount(0)
  })
})
