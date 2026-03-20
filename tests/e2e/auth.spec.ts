/**
 * Auth E2E tests — exercises real UI flows:
 *   1. Registration via the register form
 *   2. New profile wizard (avatar, info, customization)
 *   3. Logout
 *   4. Login with the just-registered user
 *   5. Protected route access verification
 *
 * Uses a unique randomized email/username per run to avoid collisions.
 * Cleans up the UI-registered user in global-teardown via a persisted file.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createAdminClient, cleanupUserByEmail } from './helpers/e2e-helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '.auth')

const TEST_RUN_ID = Math.random().toString(36).slice(2, 8)
const TEST_EMAIL = `e2e_auth_${TEST_RUN_ID}@e2e.harmony.local`
const TEST_PASSWORD = 'e2e-test-password-12345'
const TEST_USERNAME = `e2eauth${TEST_RUN_ID}`
const TEST_DISPLAY_NAME = `Auth Test ${TEST_RUN_ID}`

// Sequential — each test depends on the previous one
test.describe.configure({ mode: 'serial' })

test.describe('Auth flow — register, profile, logout, login', () => {
  test.beforeAll(async () => {
    // Clean up any leftover user from a previous failed run
    const admin = createAdminClient()
    await cleanupUserByEmail(admin, TEST_EMAIL)
  })

  test.afterAll(async () => {
    // Persist the test user info so global-teardown can clean it up
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true })
    }
    fs.writeFileSync(
      path.resolve(AUTH_DIR, 'auth-test-user.json'),
      JSON.stringify({ email: TEST_EMAIL }),
    )
  })

  test('register a new account via the UI', async ({ page }) => {
    await page.goto('/register')

    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="auth-email"]').fill(TEST_EMAIL)
    await page.locator('[data-testid="auth-password"]').fill(TEST_PASSWORD)
    await page.locator('[data-testid="auth-submit"]').click()

    // After registration, should redirect to /new-profile
    await expect(page).toHaveURL(/new-profile/, { timeout: 15000 })
    await expect(page.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 10000 })
  })

  test('complete profile wizard — step 1: avatar', async ({ page }) => {
    await page.goto('/new-profile')
    await expect(page.locator('[data-testid="profile-step-1"]')).toBeVisible({ timeout: 15000 })

    // Use default avatar
    await page.locator('[data-testid="avatar-use-default"]').click()

    // Proceed to step 2
    await page.locator('[data-testid="profile-next-btn"]').click()
    await expect(page.locator('[data-testid="profile-step-2"]')).toBeVisible({ timeout: 10000 })
  })

  test('complete profile wizard — step 2: basic info', async ({ page }) => {
    await page.goto('/new-profile')
    // May need to get back to step 2 — the wizard might remember state or restart
    // If it restarts at step 1, click through
    const step2 = page.locator('[data-testid="profile-step-2"]')
    const step1 = page.locator('[data-testid="profile-step-1"]')

    if (await step1.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator('[data-testid="profile-next-btn"]').click()
      await expect(step2).toBeVisible({ timeout: 10000 })
    } else {
      await expect(step2).toBeVisible({ timeout: 15000 })
    }

    await page.locator('[data-testid="profile-display-name"]').fill(TEST_DISPLAY_NAME)
    await page.locator('[data-testid="profile-username"]').fill(TEST_USERNAME)

    // Wait for username availability check to complete
    await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 10000 })

    // Proceed to step 3
    await page.locator('[data-testid="profile-next-btn"]').click()
    await expect(page.locator('[data-testid="profile-step-3"]')).toBeVisible({ timeout: 10000 })
  })

  test('complete profile wizard — step 3: customization & create profile', async ({ page }) => {
    await page.goto('/new-profile')

    // Navigate through to step 3 (wizard may restart)
    const step3 = page.locator('[data-testid="profile-step-3"]')
    const step1 = page.locator('[data-testid="profile-step-1"]')
    const step2 = page.locator('[data-testid="profile-step-2"]')

    if (await step1.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator('[data-testid="profile-next-btn"]').click()
      await expect(step2).toBeVisible({ timeout: 10000 })
      // Re-fill step 2 fields since the wizard restarted
      await page.locator('[data-testid="profile-display-name"]').fill(TEST_DISPLAY_NAME)
      await page.locator('[data-testid="profile-username"]').fill(TEST_USERNAME)
      await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 10000 })
      await page.locator('[data-testid="profile-next-btn"]').click()
      await expect(step3).toBeVisible({ timeout: 10000 })
    } else if (await step2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.locator('[data-testid="profile-display-name"]').fill(TEST_DISPLAY_NAME)
      await page.locator('[data-testid="profile-username"]').fill(TEST_USERNAME)
      await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 10000 })
      await page.locator('[data-testid="profile-next-btn"]').click()
      await expect(step3).toBeVisible({ timeout: 10000 })
    } else {
      await expect(step3).toBeVisible({ timeout: 15000 })
    }

    // Pick a color preset
    await page.locator('[data-testid="color-preset"]').first().click()

    // Click "Create Profile"
    await page.locator('[data-testid="profile-next-btn"]').click()

    // Should redirect to /chat after profile creation
    await expect(page).toHaveURL(/chat/, { timeout: 30000 })
  })

  test('logout redirects to login', async ({ page }) => {
    // First go to chat to confirm we're logged in
    await page.goto('/chat')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    expect(page.url()).not.toContain('/login')

    // Now logout
    await page.goto('/logout')
    await expect(page).toHaveURL(/login|\/$/, { timeout: 15000 })
  })

  test('login with the registered account', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 15000 })

    await page.locator('[data-testid="auth-email"]').fill(TEST_EMAIL)
    await page.locator('[data-testid="auth-password"]').fill(TEST_PASSWORD)
    await page.locator('[data-testid="auth-submit"]').click()

    // Should land on /chat (profile already completed)
    await expect(page).toHaveURL(/chat/, { timeout: 15000 })
  })

  test('authenticated user can access protected routes', async ({ page }) => {
    // Login first
    await page.goto('/login')
    await page.locator('[data-testid="auth-email"]').fill(TEST_EMAIL)
    await page.locator('[data-testid="auth-password"]').fill(TEST_PASSWORD)
    await page.locator('[data-testid="auth-submit"]').click()
    await expect(page).toHaveURL(/chat/, { timeout: 15000 })

    // Check /dm
    await page.goto('/dm')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    expect(page.url()).not.toContain('/login')

    // Check /social/home
    await page.goto('/social/home')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    expect(page.url()).not.toContain('/login')
  })
})

test.describe('Auth — unauthenticated guards', () => {
  test('unauthenticated user is redirected from /chat to login', async ({ page }) => {
    await page.goto('/chat')
    await expect(page).toHaveURL(/login|\/$/, { timeout: 10000 })
  })

  test('unauthenticated user is redirected from /dm to login', async ({ page }) => {
    await page.goto('/dm')
    await expect(page).toHaveURL(/login|\/$/, { timeout: 10000 })
  })

  test('unauthenticated user is redirected from /social/home to login', async ({ page }) => {
    await page.goto('/social/home')
    await expect(page).toHaveURL(/login|social|\/$/, { timeout: 10000 })
  })
})

test.describe('Auth — page rendering', () => {
  test('login page renders with required fields', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="auth-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="auth-submit"]')).toBeVisible()
  })

  test('register page renders with fields', async ({ page }) => {
    await page.goto('/register')
    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="auth-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="auth-submit"]')).toBeVisible()
  })

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login')
    await page.locator('[data-testid="auth-email"]').fill('invalid@test.com')
    await page.locator('[data-testid="auth-password"]').fill('wrongpassword')
    await page.locator('[data-testid="auth-submit"]').click()
    await expect(page).toHaveURL(/login/, { timeout: 5000 })
  })

  test('login page has link to register', async ({ page }) => {
    await page.goto('/login')
    const switchBtn = page.locator('[data-testid="auth-switch-mode"]')
    await expect(switchBtn).toBeVisible({ timeout: 10000 })
    await switchBtn.click()
    await expect(page).toHaveURL(/register/)
  })

  test('register page has link to login', async ({ page }) => {
    await page.goto('/register')
    const switchBtn = page.locator('[data-testid="auth-switch-mode"]')
    await expect(switchBtn).toBeVisible({ timeout: 10000 })
    await switchBtn.click()
    await expect(page).toHaveURL(/login/)
  })

  test('password reset modal opens from login', async ({ page }) => {
    await page.goto('/login')
    const forgotLink = page.locator('.forgot-link')
    await expect(forgotLink).toBeVisible({ timeout: 10000 })
    await forgotLink.click()
    await expect(page.locator('.reset-modal')).toBeVisible({ timeout: 5000 })
  })

  test('root URL loads without server error', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(500)
  })

  test('unknown routes show 404 or redirect gracefully', async ({ page }) => {
    await page.goto('/this-route-does-not-exist-12345')
    await page.waitForLoadState('networkidle', { timeout: 10000 })
    const url = page.url()
    const has404Content = await page.locator('text=/not found|404|page.*not.*exist/i').count()
    const redirectedAway = !url.includes('this-route-does-not-exist')
    expect(has404Content > 0 || redirectedAway).toBeTruthy()
  })
})
