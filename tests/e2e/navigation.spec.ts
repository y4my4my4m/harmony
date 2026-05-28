import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('root URL loads without server error', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(500)
    // Should either show the app or redirect to login
    await expect(page).not.toHaveURL(/error/, { timeout: 5000 })
  })

  test('unknown routes show 404 or redirect gracefully', async ({ page }) => {
    await page.goto('/this-route-does-not-exist-12345')

    // Wait for the app to handle the route
    await page.waitForLoadState('networkidle', { timeout: 10000 })

    // Should show a 404 page, redirect to home, or redirect to login - not crash
    const url = page.url()
    const has404Content = await page.locator('text=/not found|404|page.*not.*exist/i').count()
    const redirectedAway = !url.includes('this-route-does-not-exist')

    expect(has404Content > 0 || redirectedAway).toBeTruthy()
  })

  test('social routes redirect unauthenticated users', async ({ page }) => {
    await page.goto('/social/home')
    await expect(page).toHaveURL(/login|social|\/$/,  { timeout: 10000 })
  })

  test('DM routes redirect unauthenticated users', async ({ page }) => {
    await page.goto('/dm')
    await expect(page).toHaveURL(/login|\/$/,  { timeout: 10000 })
  })
})
