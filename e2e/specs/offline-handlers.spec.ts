// Journey: a signed-in page ends its presence on pagehide and beforeunload, never on unload.
// Chrome refuses unload listeners (console: "Permissions policy violation: unload is not allowed
// in this document") and other browsers keep a page with one out of the back/forward cache.

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

test('signed in, the page listens for pagehide and beforeunload and not for unload', async ({ page }) => {
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
    .toEqual(['beforeunload', 'pagehide'])
  const types: string[] = await page.evaluate(() => (window as any).__windowListenerTypes)
  expect(types).toContain('pagehide')
  expect(types).toContain('beforeunload')
  expect(types).not.toContain('unload')
  expect(violations).toEqual([])
})
