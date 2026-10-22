// Journey: replying to a post while scrolled down in Home leaves the reader where they were.
// The viewer's own reply is placed on top of the feed at once, above the window; the posts
// in view keep their place. At the top of the feed the reply shows as the first post.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
const COUNT = 30
// Timeline views compile on a cold dev server's first visit.
const APP_LOAD_MS = 90_000

let reader: SpecUser
let author: SpecUser
const label = (n: number) => `anchor post ${String(n).padStart(2, '0')}`

/**
 * create_comprehensive_timeline_entries fans a public post out to every local profile,
 * which races a profile another spec deletes meanwhile (timeline_entries_user_id_fkey);
 * the insert is atomic and is retried.
 */
async function insertPosts(rows: Record<string, unknown>[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.from('posts').insert(rows)
    if (!error) return
    if (attempt < 4 && error.message.includes('timeline_entries_user_id_fkey')) continue
    throw new Error(`posts: ${error.message}`)
  }
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'torr')
  author = await createUser(admin, 'tora')
  const { error } = await admin
    .from('follows')
    .insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
  const now = Date.now()
  await insertPosts(
    Array.from({ length: COUNT }, (_, i) => ({
      author_id: author.id,
      visibility: 'public',
      is_local: true,
      content: [{ type: 'text', text: `${label(i + 1)} by ${author.username}` }],
      created_at: new Date(now - (i + 1) * 60_000).toISOString(),
    })),
  )
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [reader?.id, author?.id].filter(Boolean))
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

const homeFeed = (page: Page) => page.getByRole('feed', { name: 'Home timeline' })
const scroller = (page: Page) => page.locator('[data-testid="timeline-feed"] .posts-container')

/** Top of the article holding `text`, relative to the scroller's top. */
const topOf = (page: Page, text: string) =>
  scroller(page).evaluate((el, wanted) => {
    const article = Array.from(el.querySelectorAll<HTMLElement>('article[aria-posinset]'))
      .find((a) => a.innerText.includes(wanted))
    return article ? Math.round(article.getBoundingClientRect().top - el.getBoundingClientRect().top) : null
  }, text)

test('an own reply posted while scrolled down keeps the posts in view in place', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await expect(homeFeed(page).locator('article[aria-posinset="1"]')).toBeVisible({ timeout: APP_LOAD_MS })

  // Scrolled well past the top, as the audit's 1400 px.
  await scroller(page).evaluate((el) => { el.scrollTop = 1400 })
  let target = ''
  await expect.poll(async () => {
    target = await scroller(page).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const middle = Array.from(el.querySelectorAll<HTMLElement>('article[aria-posinset]')).find((a) => {
        const r = a.getBoundingClientRect()
        return r.top > box.top + 150 && r.bottom < box.bottom - 150
      })
      return /anchor post \d+/.exec(middle?.innerText ?? '')?.[0] ?? ''
    })
    return target
  }, { timeout: 15000 }).not.toBe('')
  const post = homeFeed(page).locator('article[aria-posinset]').filter({ hasText: target })

  // Pressed where it is: a locator click scrolls its target first.
  const reply = post.getByTestId('post-reply-btn')
  const box = (await reply.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const editor = post.locator('[data-testid="compose-post"] .rich-text-editor')
  await expect(editor).toBeFocused({ timeout: 15000 })
  await page.keyboard.type('a reply from below', { delay: 15 })

  const before = await topOf(page, target)
  const posinset = Number(await post.getAttribute('aria-posinset'))
  expect(before).not.toBeNull()
  const written = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/posts') && r.request().method() === 'POST',
    { timeout: 30000 },
  )
  const submit = post.getByTestId('compose-submit')
  const submitBox = (await submit.boundingBox())!
  await page.mouse.click(submitBox.x + submitBox.width / 2, submitBox.y + submitBox.height / 2)
  expect((await written).ok()).toBe(true)
  await expect(post.locator('[data-testid="compose-post"]')).toHaveCount(0, { timeout: 15000 })

  // The reply is listed above the window, one place ahead of the replied-to post, which does
  // not move.
  await expect(post).toHaveAttribute('aria-posinset', String(posinset + 1), { timeout: 15000 })
  await page.waitForTimeout(1000)
  const after = await topOf(page, target)
  expect(Math.abs((after ?? 9999) - before!)).toBeLessThanOrEqual(2)

  await scroller(page).evaluate((el) => { el.scrollTop = 0 })
  await expect(homeFeed(page).locator('article[aria-posinset="1"]')).toContainText('a reply from below', { timeout: 15000 })
})
