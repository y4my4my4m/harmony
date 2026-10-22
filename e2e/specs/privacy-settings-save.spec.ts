// Journey: Privacy & safety applies each switch as it is flipped, as Notifications does, and
// confirms it. It has no Save or Reset button. Both switches hold after a reload.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'privsave')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const privacy = (page: Page) => page.locator('.privacy-settings')
const followToggle = (page: Page) => page.locator('[data-testid="follow-approval-toggle"]')
const stripToggle = (page: Page) => page.locator('[data-testid="strip-url-trackers-toggle"]')
const savedToast = (page: Page) => page.locator('.Vue-Toastification__toast').filter({ hasText: 'Privacy settings updated' })

async function approvesFollowers(): Promise<boolean> {
  const { data } = await admin.from('profiles').select('manually_approves_followers').eq('id', user.id).single()
  return (data as { manually_approves_followers: boolean }).manually_approves_followers === true
}

test('each privacy switch saves as it is flipped and says so', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/settings/privacy')
  await dismissAnnouncements(page)
  await expect(followToggle(page)).toBeVisible({ timeout: 30000 })
  await expect(followToggle(page)).not.toHaveClass(/disabled/, { timeout: 15000 })

  await test.step('no Save or Reset that nothing can enable', async () => {
    await expect(privacy(page).getByRole('button', { name: /^(Save changes|Save|Reset)$/ })).toHaveCount(0)
  })

  await test.step('follow approval: stored and confirmed', async () => {
    await expect(followToggle(page)).toHaveAttribute('aria-checked', 'false')
    await followToggle(page).click()
    await expect(followToggle(page)).toHaveAttribute('aria-checked', 'true')
    await expect(savedToast(page)).toHaveCount(1, { timeout: 10000 })
    await expect.poll(approvesFollowers).toBe(true)
  })

  await test.step('tracking parameters: stored and confirmed', async () => {
    await expect(stripToggle(page)).toHaveAttribute('aria-checked', 'true')
    await stripToggle(page).click()
    await expect(stripToggle(page)).toHaveAttribute('aria-checked', 'false')
    await expect(savedToast(page)).toHaveCount(2, { timeout: 10000 })
    expect(await page.evaluate(() => localStorage.getItem('harmony-privacy-strip-url-trackers'))).toBe('false')
  })

  await test.step('both hold after a reload', async () => {
    await page.reload()
    await expect(followToggle(page)).toHaveAttribute('aria-checked', 'true', { timeout: 30000 })
    await expect(stripToggle(page)).toHaveAttribute('aria-checked', 'false')
  })
})
