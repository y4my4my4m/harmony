// Journey: a post typed with remote mentions followed by text on the next line and
// after punctuation stores each mention under its own host. Stored posts held hosts
// with the next word attached (spacify.cloudit, mastodon.gamedev.placeThis).
//
// The handles name no stored account, so each is stored unresolved, under the host
// typed; the federation worker resolves them on delivery.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let author: SpecUser

test.beforeAll(async () => {
  author = await createUser(admin, 'mnb')
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', author?.id ?? '')
  await deleteUser(admin, author)
})

test('mentions typed before a new line and before punctuation keep their hosts', async ({ page }) => {
  test.setTimeout(180_000)

  const editor = page.locator('[data-testid="compose-post"] .rich-text-editor')
  const suggestions = page.locator('.auto-suggest')

  // A handle closes the suggestion list once nothing matches; Enter then breaks the line.
  const typeHandle = async (handle: string) => {
    await page.keyboard.type(handle, { delay: 20 })
    await expect(suggestions).toHaveCount(0, { timeout: 10000 })
  }

  await test.step('sign in and open the composer', async () => {
    await signIn(page, author)
    await page.goto('/social/local')
    await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 30000 })
    await page.locator('[data-testid="compose-btn"]').click()
    await expect(editor).toBeVisible({ timeout: 15000 })
    await editor.click()
  })

  await test.step('type a mention, a new line, and a mention before a comma', async () => {
    await typeHandle('@kai@spacify.cloud')
    await page.keyboard.press('Enter')
    await page.keyboard.type('it works', { delay: 20 })
    await page.keyboard.press('Enter')
    await typeHandle('@nyx@mastodon.gamedev.place')
    await page.keyboard.type(', This too', { delay: 20 })
  })

  await test.step('publish', async () => {
    const written = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/posts') && r.request().method() === 'POST',
      { timeout: 30000 },
    )
    await page.locator('[data-testid="compose-submit"]').click()
    expect((await written).ok()).toBe(true)
  })

  await test.step('each mention is stored under its own host', async () => {
    const { data, error } = await admin
      .from('posts')
      .select('content')
      .eq('author_id', author.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    expect(error).toBeNull()
    const parts = data!.content as Array<Record<string, any>>
    const mentions = parts.filter((p) => p.type === 'mention')
    expect(mentions.map((m) => `${m.username}@${m.domain}`)).toEqual([
      'kai@spacify.cloud',
      'nyx@mastodon.gamedev.place',
    ])
    expect(mentions.map((m) => m.userId)).toEqual([
      'unresolved-kai@spacify.cloud',
      'unresolved-nyx@mastodon.gamedev.place',
    ])
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('|')
    expect(text).toContain('\nit works\n')
    expect(text).toContain(', This too')
  })
})
