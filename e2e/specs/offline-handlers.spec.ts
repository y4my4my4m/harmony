// Journey: a signed-in page ends its presence on pagehide alone, never on unload or
// beforeunload. Chrome refuses unload listeners (console: "Permissions policy violation: unload
// is not allowed in this document") and other browsers keep a page with one out of the
// back/forward cache; beforeunload with pagehide sent presence_offline twice per close.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let member: SpecUser

test.beforeAll(async () => {
  member = await createUser(admin, 'offh')
})

test.afterAll(async () => {
  await deleteUser(admin, member)
})

test('signed in, the page ends its presence on pagehide, once per close', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as any).__windowListenerTypes = seen
    const add = window.addEventListener.bind(window)
    window.addEventListener = ((type: string, ...rest: any[]) => {
      seen.push(type)
      return (add as any)(type, ...rest)
    }) as typeof window.addEventListener
  })
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Permissions policy violation: unload/i.test(message.text())) violations.push(message.text())
  })

  await signIn(page, member)
  await expect
    .poll(() => page.evaluate(() => (window as any).__harmonyOfflineHandlers && Object.keys((window as any).__harmonyOfflineHandlers).sort()), { timeout: 30000 })
    .toEqual(['pagehide'])
  const types: string[] = await page.evaluate(() => (window as any).__windowListenerTypes)
  expect(types).toContain('pagehide')
  expect(types).not.toContain('unload')
  expect(violations).toEqual([])

  const offline: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/rest/v1/rpc/presence_offline')) offline.push(request.method())
  })
  // The presence hook is installed once this tab's presence has started.
  await expect.poll(() => page.evaluate(() => typeof (window as any).__harmonyPresenceCleanup), { timeout: 30000 })
    .toBe('function')
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'))
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
  })
  await expect.poll(() => offline.length, { timeout: 5000 }).toBe(1)
  await page.waitForTimeout(1000)
  expect(offline).toEqual(['POST'])
})
