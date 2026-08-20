// Journey: a stranger registers, completes the profile wizard, signs out and
// signs back in.
//
// The account under test is created through the UI and removed in teardown.
// The second test needs an account that already exists, and takes a seeded one
// so that a registration failure cannot be read as a rejected password.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  PASSWORD,
  type SpecUser,
} from './harness'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const USERNAME = `signup${RUN}`.toLowerCase()
const EMAIL = `${USERNAME}@e2e.harmony.local`
const DISPLAY_NAME = `Signup ${RUN}`

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let existing: SpecUser

test.beforeAll(async () => {
  existing = await createUser(admin, 'guard')
})

test.afterAll(async () => {
  await deleteUser(admin, existing)

  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const user = data?.users?.find((u) => u.email === EMAIL)
  if (!user) return
  await admin.from('profiles').delete().eq('id', user.id)
  await admin.auth.admin.deleteUser(user.id)
})

test('sign up, complete the profile, sign out, sign back in', async ({ page }) => {
  test.setTimeout(180_000)

  await test.step('register with an unused address', async () => {
    await page.goto('/register')
    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 30000 })
    await page.locator('[data-testid="auth-email"]').fill(EMAIL)
    await page.locator('[data-testid="auth-password"]').fill(PASSWORD)
    await page.locator('[data-testid="auth-submit"]').click()

    await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
    await expect(page.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 15000 })
  })

  await test.step('keep the default avatar', async () => {
    await expect(page.locator('[data-testid="profile-step-1"]')).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="avatar-use-default"]').click()
    await page.locator('[data-testid="profile-next-btn"]').click()
    await expect(page.locator('[data-testid="profile-step-2"]')).toBeVisible({ timeout: 15000 })
  })

  await test.step('claim a username the instance reports as free', async () => {
    await page.locator('[data-testid="profile-display-name"]').fill(DISPLAY_NAME)
    await page.locator('[data-testid="profile-username"]').fill(USERNAME)
    await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="profile-next-btn"]').click()
    await expect(page.locator('[data-testid="profile-step-3"]')).toBeVisible({ timeout: 15000 })
  })

  await test.step('finish the wizard and land in the app', async () => {
    await page.locator('[data-testid="color-preset"]').first().click()
    await page.locator('[data-testid="profile-next-btn"]').click()

    await expect(page).toHaveURL(/\/chat/, { timeout: 60000 })
    await dismissAnnouncements(page)
    await expect(page.locator('.user-profile .user-name')).toHaveText(DISPLAY_NAME, {
      timeout: 30000,
    })
  })

  await test.step('sign out', async () => {
    await page.goto('/logout')
    await page.locator('[data-testid="logout-confirm-btn"]').click()
    await expect(page).toHaveURL(/login|\/$/, { timeout: 30000 })

    // The guard, not the button, is what proves the session is gone.
    await page.goto('/chat')
    await expect(page).toHaveURL(/login|\/$/, { timeout: 30000 })
  })

  await test.step('sign back in with the same credentials', async () => {
    await page.goto('/login')
    await page.locator('[data-testid="auth-email"]').fill(EMAIL)
    await page.locator('[data-testid="auth-password"]').fill(PASSWORD)
    await page.locator('[data-testid="auth-submit"]').click()

    await expect(page).toHaveURL(/\/chat/, { timeout: 30000 })
    await dismissAnnouncements(page)
    await expect(page.locator('.user-profile .user-name')).toHaveText(DISPLAY_NAME, {
      timeout: 30000,
    })
  })
})

test('a wrong password does not sign an existing account in', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 30000 })
  await page.locator('[data-testid="auth-email"]').fill(existing.email)
  await page.locator('[data-testid="auth-password"]').fill('not-the-password')

  // Asserting the URL straight after the click passes on the pre-navigation
  // state, so the answer is waited for first.
  const answered = page.waitForResponse((r) => r.url().includes('/auth/v1/token'), {
    timeout: 30000,
  })
  await page.locator('[data-testid="auth-submit"]').click()
  await answered
  await page.waitForTimeout(2000)

  await expect(page.locator('[data-testid="auth-form"]')).toBeVisible()
  await expect(page).toHaveURL(/login/)

  await page.goto('/chat')
  await expect(page).toHaveURL(/login|\/$/, { timeout: 15000 })
})
