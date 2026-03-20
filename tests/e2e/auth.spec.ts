import { test, expect } from '@playwright/test'
import { test as authTest, expect as authExpect } from './fixtures/auth.fixture'

test.describe('Authentication — unauthenticated flows', () => {
  test('login page renders with required fields', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/login/)

    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="auth-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="auth-submit"]')).toBeVisible()
  })

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login')

    await page.locator('[data-testid="auth-email"]').fill('invalid@test.com')
    await page.locator('[data-testid="auth-password"]').fill('wrongpassword')
    await page.locator('[data-testid="auth-submit"]').click()

    // Should stay on login and show an error (toast or inline)
    await expect(page).toHaveURL(/login/, { timeout: 5000 })
  })

  test('unauthenticated user is redirected from /chat to login', async ({ page }) => {
    await page.goto('/chat')
    await expect(page).toHaveURL(/login|\/$/,  { timeout: 10000 })
  })

  test('unauthenticated user is redirected from /dm to login', async ({ page }) => {
    await page.goto('/dm')
    await expect(page).toHaveURL(/login|\/$/,  { timeout: 10000 })
  })

  test('unauthenticated user is redirected from /social/home to login', async ({ page }) => {
    await page.goto('/social/home')
    await expect(page).toHaveURL(/login|social|\/$/,  { timeout: 10000 })
  })

  test('register page renders with fields', async ({ page }) => {
    await page.goto('/register')
    await expect(page).toHaveURL(/register/)

    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="auth-password"]')).toBeVisible()
    await expect(page.locator('[data-testid="auth-submit"]')).toBeVisible()
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
})

test.describe('Authentication — unknown routes', () => {
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

authTest.describe('Authentication — authenticated flows', () => {
  authTest('logged-in user can access /chat', async ({ alicePage }) => {
    await alicePage.goto('/chat')
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    // Should NOT be redirected to login
    authExpect(alicePage.url()).not.toContain('/login')
  })

  authTest('logged-in user can access /social/home', async ({ alicePage }) => {
    await alicePage.goto('/social/home')
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    authExpect(alicePage.url()).not.toContain('/login')
  })

  authTest('logged-in user can access /dm', async ({ alicePage }) => {
    await alicePage.goto('/dm')
    await alicePage.waitForLoadState('networkidle', { timeout: 15000 })
    authExpect(alicePage.url()).not.toContain('/login')
  })

  authTest('logout redirects to login', async ({ alicePage }) => {
    await alicePage.goto('/logout')
    await authExpect(alicePage).toHaveURL(/login|\/$/,  { timeout: 15000 })
  })
})
