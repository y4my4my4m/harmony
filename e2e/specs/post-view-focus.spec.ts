// Journey: a post opened deep in a thread is on screen when the page shows. It sits at the
// top of the view with its ancestors listed above it, scrolled past, or as near the top as
// the end of the thread allows. A post the link highlights is scrolled to instead.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const DEPTH = 7
let reader: SpecUser
let author: SpecUser
// chain[0] is the root; chain[n] answers chain[n - 1].
const chain: string[] = []

const filler = 'Thread filler that wraps over a few lines so each post takes some height in the column. '
const label = (n: number) => (n === 0 ? 'chain root' : `chain depth ${n}`)

test.beforeAll(async () => {
  // A worker that runs this file again after afterAll starts a new chain.
  chain.length = 0
  reader = await createUser(admin, 'pvfr')
  author = await createUser(admin, 'pvfa')
  const start = Date.now() - 60 * 60_000
  for (let n = 0; n <= DEPTH; n++) {
    const { data, error } = await admin
      .from('posts')
      .insert({
        author_id: author.id,
        visibility: 'public',
        is_local: true,
        content: [{ type: 'text', text: `${label(n)}. ${filler.repeat(3)}` }],
        in_reply_to: n === 0 ? null : chain[n - 1],
        created_at: new Date(start + n * 60_000).toISOString(),
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`post ${n}: ${error?.message}`)
    chain.push(data.id)
  }
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', author?.id ?? '')
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

const scroller = (page: Page) => page.locator('.post-view > .post-content')
const threadPost = (page: Page, n: number) =>
  page.locator('.post-view .thread-post').filter({ hasText: `${label(n)}.` })

/** Opened post's top below the view's top, px, and whether the view is scrolled to its end. */
const mainPlacement = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector('.post-view > .post-content')!
    const main = document.querySelector('.post-view .is-main-post')!
    return {
      gap: Math.round(main.getBoundingClientRect().top - view.getBoundingClientRect().top),
      atEnd: view.scrollHeight - view.clientHeight - view.scrollTop < 2,
    }
  })

test('a reply opened deep in its thread shows under its scrolled-past ancestors', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${chain[DEPTH]}`)
  const main = page.locator('.post-view article[aria-current="true"]')
  await expect(main).toContainText(label(DEPTH), { timeout: 90_000 })
  await expect(page.locator('.post-view .thread-post')).toHaveCount(DEPTH + 1)

  // The thread is taller than the view: the ancestors alone push the post below the fold.
  const tall = await scroller(page).evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)
  expect(tall).toBe(true)

  await expect(main).toBeInViewport({ ratio: 0.9, timeout: 10000 })
  // The last post of the thread: the view is at its end, the post whole and the root scrolled past.
  const { gap, atEnd } = await mainPlacement(page)
  expect(gap).toBeGreaterThanOrEqual(-1)
  expect(atEnd).toBe(true)
  await expect(threadPost(page, 0)).not.toBeInViewport()
})

test('a post opened mid-thread sits at the top of the view, replies below it', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${chain[3]}`)
  const main = page.locator('.post-view article[aria-current="true"]')
  await expect(main).toContainText(label(3), { timeout: 90_000 })
  await expect(page.locator('.post-view .thread-post')).toHaveCount(DEPTH + 1)

  await expect.poll(async () => Math.abs((await mainPlacement(page)).gap), { timeout: 10000 }).toBeLessThanOrEqual(2)
  await expect(threadPost(page, 2)).not.toBeInViewport()
  await expect(threadPost(page, 4)).toBeInViewport()
})

test('a highlighted reply is scrolled to instead of the opened post', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${chain[1]}?highlight=${chain[DEPTH]}`)
  await expect(page.locator('.post-view article[aria-current="true"]')).toContainText(label(1), { timeout: 90_000 })
  await expect(threadPost(page, DEPTH)).toBeInViewport({ ratio: 0.9, timeout: 10000 })
})

test('a root post opens at the top', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${chain[0]}`)
  await expect(page.locator('.post-view article[aria-current="true"]')).toContainText(label(0), { timeout: 90_000 })
  await expect(page.locator('.post-view .thread-post')).toHaveCount(DEPTH + 1)
  await page.waitForTimeout(500)
  await expect(scroller(page)).toHaveJSProperty('scrollTop', 0)
})
