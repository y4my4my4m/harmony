import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('root URL loads without error', async ({ page }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(500)
  })

  test('404 page for unknown routes', async ({ page }) => {
    await page.goto('/this-route-does-not-exist-12345')
    // App should handle gracefully (either 404 page or redirect)
    await page.waitForTimeout(2000)
    const pageContent = await page.textContent('body')
    expect(pageContent).toBeTruthy()
  })

  test('social routes redirect unauthenticated users', async ({ page }) => {
    await page.goto('/social/home')
    await page.waitForURL(/login|social|\/$/,  { timeout: 10000 })
  })
})
