// Journey: a chunk of the loaded bundle that no longer exists on the server reloads the page,
// in a tab that reloaded for the same reason before as well.
//
// A self-hosted web image keeps no files of the previous version: a tab open across an update
// fails its next lazy import, and only a reload brings the new version; without it a sign-in in
// that tab succeeds and the page stays on the sign-in form. The dev server builds no bundle, so
// the spec dispatches the event Vite's preload helper fires (vite:preloadError) and reads whether
// the page reloads.

import { test, expect, type Page } from '@playwright/test'
import { loadApp } from './harness'

const KEY = 'harmony:preload-reload'

async function setup(page: Page) {
  await loadApp(page, '/login', page.locator('[data-testid="auth-email"]'))
}

/** Dispatches vite:preloadError with the guard record set to `record`; true when the page reloads. */
async function staleChunk(page: Page, record: string | null): Promise<boolean> {
  await page.evaluate(([key, value]) => {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
    ;(window as unknown as { __beforeReload?: boolean }).__beforeReload = true
  }, [KEY, record] as const)
  const reloaded = page.waitForEvent('load', { timeout: 5000 }).then(() => true, () => false)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
  }).catch(() => {})
  if (!(await reloaded)) return false
  await page.locator('[data-testid="auth-email"]').waitFor()
  return !(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload === true))
}

test.describe('stale chunk reload', () => {
  test('reloads in a tab that reloaded before, once per bundle', async ({ page }) => {
    await setup(page)

    // An earlier reload of this tab, recorded by the guard before this change.
    expect(await staleChunk(page, '1')).toBe(true)
    const record = await page.evaluate((key) => sessionStorage.getItem(key), KEY)
    const { bundle, at } = JSON.parse(record ?? '{}') as { bundle: string; at: number }
    expect(bundle).toContain('/src/main.ts')
    expect(typeof at).toBe('number')

    // The same bundle failing again right after its reload: the server still lacks the file.
    expect(await staleChunk(page, JSON.stringify({ bundle, at: Date.now() }))).toBe(false)

    // A reload of another bundle earlier in the tab, and one of this bundle long ago.
    expect(await staleChunk(page, JSON.stringify({ bundle: 'http://localhost/assets/index-OLDBUILD.js', at: Date.now() }))).toBe(true)
    expect(await staleChunk(page, JSON.stringify({ bundle, at: Date.now() - 11 * 60 * 1000 }))).toBe(true)
  })
})
