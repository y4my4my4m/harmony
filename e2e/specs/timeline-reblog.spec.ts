// Journey: post to the local timeline, reblog it, and read the count back.
//
// The count comes from posts.reblogs_count, which a trigger recomputes from the
// reblog posts; the store refreshes it from realtime, absent here, so the
// count is read after a reload. A reblog puts two entries on the timeline: the
// boost (.is-reblog) and the original. The count lives on the original.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let author: SpecUser

test.beforeAll(async () => {
  author = await createUser(admin, 'reb')
})

test.afterAll(async () => {
  await deleteUser(admin, author)
})

test('reblogging a fresh post moves its count from none to one', async ({ page }) => {
  test.setTimeout(180_000)

  const text = `reblog target ${author.username}`
  const original = page
    .locator('[data-testid="post-item"]:not(.is-reblog)')
    .filter({ hasText: text })
    .first()
  const reblogButton = original.locator('[data-testid="post-reblog-btn"]')

  await test.step('sign in and open the local timeline', async () => {
    await signIn(page, author)
    await page.goto('/social/local')
    await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 30000 })
  })

  await test.step('publish a post', async () => {
    await page.locator('[data-testid="compose-btn"]').click()
    const editor = page.locator('[data-testid="compose-post"] .rich-text-editor')
    await expect(editor).toBeVisible({ timeout: 15000 })
    await editor.click()
    await editor.fill(text)
    await page.locator('[data-testid="compose-submit"]').click()

    await expect(original).toBeVisible({ timeout: 30000 })
  })

  await test.step('a post nobody boosted shows no reblog count', async () => {
    await expect(reblogButton).toHaveText('')
  })

  await test.step('reblog it', async () => {
    await reblogButton.click()
    const menu = page.locator('.reblog-dropdown')
    await expect(menu).toBeVisible({ timeout: 10000 })

    // A boost is a second row in posts. Nothing in the timeline marks it as
    // written, and reloading first aborts the request, so the write is waited
    // for here rather than asserted on.
    const boostWritten = page.waitForResponse(
      (response) =>
        response.url().includes('/rest/v1/posts') && response.request().method() === 'POST',
      { timeout: 30000 },
    )
    await menu.locator('.reblog-option').filter({ hasText: 'Reblog' }).first().click()
    await boostWritten
    await expect(menu).toBeHidden({ timeout: 10000 })
  })

  await test.step('the count reads 1', async () => {
    // Counts and is_reblogged reach an open timeline over realtime, which this
    // stack does not run, so the timeline is re-fetched until it settles.
    await expect(async () => {
      await page.reload()
      await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 30000 })
      await expect(original).toBeVisible({ timeout: 15000 })
      await expect(reblogButton).toHaveText('1', { timeout: 5000 })
      await expect(reblogButton).toHaveClass(/active/, { timeout: 5000 })
    }).toPass({ timeout: 90000, intervals: [2000, 3000, 5000] })

    // The boost itself is on the timeline, beside the original.
    await expect(
      page.locator('[data-testid="post-item"].is-reblog').filter({ hasText: text }),
    ).toHaveCount(1)
  })
})
