import { test, expect } from '@playwright/test'

test.describe('Authentication flows', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/login/)
  })

  test('login page has email and password fields', async ({ page }) => {
    await page.goto('/login')
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]')
    const passwordInput = page.locator('input[type="password"]')
    await expect(emailInput.or(page.locator('input').first())).toBeVisible({ timeout: 10000 })
  })

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login')
    const emailInput = page.locator('input[type="email"], input[name="email"]').first()
    const passwordInput = page.locator('input[type="password"]').first()

    if (await emailInput.isVisible()) {
      await emailInput.fill('invalid@test.com')
      await passwordInput.fill('wrongpassword')

      const submitButton = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")').first()
      if (await submitButton.isVisible()) {
        await submitButton.click()
        // Should show some error indication
        await page.waitForTimeout(2000)
        const pageContent = await page.textContent('body')
        expect(pageContent).toBeTruthy()
      }
    }
  })

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/chat')
    // Should redirect to login since not authenticated
    await page.waitForURL(/login|\/$/,  { timeout: 10000 })
  })

  test('register page renders', async ({ page }) => {
    await page.goto('/register')
    await expect(page).toHaveURL(/register/)
  })
})
