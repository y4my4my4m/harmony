// Journey: a timeline keeps its loaded pages and the reader's place. Switching to another
// timeline and back, and opening a post and going Back, return to the same post at the
// same offset with every loaded page still listed. A post published meanwhile waits
// behind the "new posts" pill rather than moving the list, and the pill shows it on top.
// On a phone the post view's own Back button returns to the same place.
//
// The stack runs no realtime, so the post published while away reaches the timeline
// through the head refresh that runs when the timeline is shown again.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
// Four pages of 20; the last is short, so the feed knows its size once all are loaded.
const COUNT = 70
// Timeline views compile on a cold dev server's first visit.
const APP_LOAD_MS = 90_000

let reader: SpecUser
let author: SpecUser
const label = (n: number) => `memory post ${String(n).padStart(2, '0')}`

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
  reader = await createUser(admin, 'trpr')
  author = await createUser(admin, 'trpa')
  const { error } = await admin
    .from('follows')
    .insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
  // Post 1 is the newest; a minute apart.
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
  await admin.from('posts').delete().eq('author_id', author?.id ?? '')
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

const homeFeed = (page: Page) => page.getByRole('feed', { name: 'Home timeline' })
const article = (page: Page, n: number) => homeFeed(page).locator(`article[aria-posinset="${n}"]`)
const scroller = (page: Page) => page.locator('[data-testid="timeline-feed"] .posts-container')

/** The first article whose bottom edge is below the scroller's top, and px of it above that edge. */
const readingPosition = (page: Page) =>
  scroller(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const first = Array.from(el.querySelectorAll<HTMLElement>('article[aria-posinset]'))
      .find((a) => a.getBoundingClientRect().bottom > top)
    if (!first) return null
    return {
      posinset: first.getAttribute('aria-posinset'),
      post: /memory post \d+/.exec(first.innerText)?.[0] ?? null,
      offset: Math.round(top - first.getBoundingClientRect().top),
    }
  })

type Position = NonNullable<Awaited<ReturnType<typeof readingPosition>>>

/** Signs in, opens the home timeline and scrolls until article `n` is listed. */
async function loadHome(page: Page, n: number) {
  await signIn(page, reader)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await expect(article(page, 1)).toBeVisible({ timeout: APP_LOAD_MS })
  await expect(async () => {
    await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(article(page, n)).toBeAttached({ timeout: 2000 })
  }).toPass({ timeout: 120_000, intervals: [500, 1000, 1000] })
}

/** Puts article `n` at the scroller's top, `offset` px of it scrolled past, and returns the settled position. */
async function stopAt(page: Page, n: number, offset: number): Promise<Position> {
  // Rows render near the viewport only: page towards the article until it is rendered.
  await expect(async () => {
    await scroller(page).evaluate((el, target) => {
      const shown = Array.from(el.querySelectorAll('article[aria-posinset]')).map((a) => Number(a.getAttribute('aria-posinset')))
      if (shown.includes(target)) return
      el.scrollTop += (Math.min(...shown) > target ? -1 : 1) * el.clientHeight
    }, n)
    await expect(article(page, n)).toBeAttached({ timeout: 500 })
  }).toPass({ timeout: 30000, intervals: [100] })
  await article(page, n).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await scroller(page).evaluate((el, by) => { el.scrollTop += by }, offset)
  // On a phone, scrolling down slides the home composer away over 250 ms.
  let last = ''
  await expect.poll(async () => {
    const now = JSON.stringify(await readingPosition(page))
    const settled = now === last
    last = now
    return settled
  }, { intervals: [300] }).toBe(true)
  const position = (await readingPosition(page))!
  expect(position.posinset).toBe(String(n))
  return position
}

/**
 * Presses a link where it is. A locator click scrolls its target into view first, and on
 * a retry with another alignment, which moves the reading position before the post opens.
 */
async function pressInPlace(page: Page, link: Locator, touch: boolean) {
  const box = (await link.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

async function expectPosition(page: Page, before: Position) {
  await expect.poll(async () => {
    const now = await readingPosition(page)
    return now && { posinset: now.posinset, post: now.post, near: Math.abs(now.offset - before.offset) <= 2 }
  }, { timeout: 15000 }).toEqual({ posinset: before.posinset, post: before.post, near: true })
}

test('a timeline keeps its pages and the reading position across a tab switch and Back', async ({ page }) => {
  test.setTimeout(300_000)
  let before: Position

  await test.step('load every page of the home timeline', async () => {
    await loadHome(page, COUNT)
    // Everything is listed: the set size is known.
    await expect(article(page, COUNT)).toHaveAttribute('aria-setsize', String(COUNT))
  })

  await test.step('stop part-way into the third page', async () => {
    before = await stopAt(page, 45, 37)
    expect(before.post).toBe(label(45))
  })

  await test.step('Local and back to Home returns to the same post', async () => {
    await page.getByRole('tab', { name: 'Local' }).click()
    await expect(page.getByRole('feed', { name: 'Local timeline' })).toBeVisible({ timeout: 30000 })
    await page.getByRole('tab', { name: 'Home' }).click()
    await expect(homeFeed(page)).toBeVisible({ timeout: 30000 })
    await expectPosition(page, before)
    await expect(article(page, 45)).toHaveAttribute('aria-setsize', String(COUNT))
  })

  await test.step('opening a post and going Back returns to the same post', async () => {
    await pressInPlace(page, article(page, 47).locator('.post-time').first(), false)
    await page.waitForURL(/\/social\/post\//, { timeout: 30000 })
    await expect(page.locator('article[aria-current="true"]')).toContainText(label(47), { timeout: 30000 })

    await insertPosts([{
      author_id: author.id,
      visibility: 'public',
      is_local: true,
      content: [{ type: 'text', text: `fresh post by ${author.username}` }],
      created_at: new Date().toISOString(),
    }])

    await page.goBack()
    await page.waitForURL(/\/social\/home/, { timeout: 30000 })
    await expect(homeFeed(page)).toBeVisible({ timeout: 30000 })
    await expectPosition(page, before)
    await expect(article(page, 45)).toHaveAttribute('aria-setsize', String(COUNT))
  })

  await test.step('the post published meanwhile waits behind the pill, which shows it on top', async () => {
    const pill = page.getByTestId('new-posts-pill')
    await expect(pill).toHaveText(/1 new post/, { timeout: 30000 })
    await expectPosition(page, before)
    await pill.click()
    await expect(article(page, 1)).toContainText(`fresh post by ${author.username}`)
    await expect(article(page, 2)).toContainText(label(1))
    await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0)
  })
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('the post view\'s Back button and a tab switch return to the same post', async ({ page }) => {
    test.setTimeout(300_000)
    let before: Position

    await test.step('scroll into the second page', async () => {
      await loadHome(page, 30)
      before = await stopAt(page, 15, 23)
    })

    await test.step('open a post and tap Back', async () => {
      await pressInPlace(page, article(page, 16).locator('.post-time').first(), true)
      await page.waitForURL(/\/social\/post\//, { timeout: 30000 })
      await page.getByRole('button', { name: 'Back' }).first().tap()
      await page.waitForURL(/\/social\/home/, { timeout: 30000 })
      await expect(homeFeed(page)).toBeVisible({ timeout: 30000 })
      await expectPosition(page, before)
    })

    await test.step('Local and back to Home', async () => {
      await page.getByRole('tab', { name: 'Local' }).tap()
      await expect(page.getByRole('feed', { name: 'Local timeline' })).toBeVisible({ timeout: 30000 })
      await page.getByRole('tab', { name: 'Home' }).tap()
      await expect(homeFeed(page)).toBeVisible({ timeout: 30000 })
      await expectPosition(page, before)
    })
  })
})
