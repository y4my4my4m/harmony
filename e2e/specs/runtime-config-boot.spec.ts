// Journey: the web app's start against /config.json. A build that leaves VITE_RUNTIME_CONFIG
// unset (the self-host web image) reads the file once, past every cache, and starts on the
// build's values when it is absent or stalls past the fetch timeout. A build with
// VITE_RUNTIME_CONFIG=off (an instance serving no such file) never requests it, so a stalled
// file costs it nothing.
//
// The dev server's own setting decides which half applies: Vite takes a VITE_* from the
// process environment first, then from the .env files.

import { test, expect, type Page } from '@playwright/test'
import { loadEnv } from 'vite'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const setting = process.env.VITE_RUNTIME_CONFIG ?? loadEnv('development', root, 'VITE_').VITE_RUNTIME_CONFIG
const off = (setting || '').trim().toLowerCase() === 'off'
/** src/services/runtimeConfig.ts FETCH_TIMEOUT_MS */
const FETCH_TIMEOUT_MS = 10_000

function configRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/config.json') seen.push(request.url())
  })
  return seen
}

test(`the app starts with /config.json absent (VITE_RUNTIME_CONFIG ${off ? 'off' : 'unset'})`, async ({ page }) => {
  const seen = configRequests(page)
  await page.route('**/config.json*', (route) => route.fulfill({ status: 404, body: '' }))
  await page.goto('/login')
  await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
  if (off) {
    expect(seen).toEqual([])
  } else {
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/\/config\.json\?t=\d+$/)
  }
})

test(`a stalled /config.json ${off ? 'does not hold the start' : 'holds the start until the fetch timeout'}`, async ({ page }) => {
  test.setTimeout(60_000)
  const seen = configRequests(page)
  // Never answered.
  await page.route('**/config.json*', () => {})
  const started = Date.now()
  await page.goto('/login', { waitUntil: 'commit' })
  await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: FETCH_TIMEOUT_MS + 20_000 })
  const elapsed = Date.now() - started
  if (off) {
    expect(seen).toEqual([])
    expect(elapsed).toBeLessThan(FETCH_TIMEOUT_MS)
  } else {
    expect(seen).toHaveLength(1)
    expect(elapsed).toBeGreaterThanOrEqual(FETCH_TIMEOUT_MS)
  }
})
