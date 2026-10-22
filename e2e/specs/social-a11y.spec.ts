// Journeys: the social area as a keyboard and screen-reader user meets it.
//
// The home timeline is a WAI-ARIA feed: articles named by author and time, with
// positions and a hidden heading each; PageDown/PageUp and j/k move between them,
// Ctrl+End leaves the feed for Load more, which announces what it loaded and moves
// focus to the first new post; a focused post stays rendered when scrolled away.
// A post's More menu and the boost menu follow the menu pattern; boost and
// favourite are toggles with fixed names, counts in the name and aria-pressed.
// Profile and follow tabs are tablists; a follow request is accepted from a button
// named with the requester. The composer is a dialog whose visibility picker is a
// menu of radio items, and an image is posted with alt text from the keyboard.
// Sensitive media is out of the accessibility tree until its reveal button, which
// comes first, is used. The user search dialog labels its field, announces results
// and exposes its filters as pressed toggles. axe runs on the social screens
// (exclusions: e2e/specs/a11y.ts AXE_EXCLUSIONS).
//
// Rows are seeded through the service role; every interaction goes through the UI.
// Each test owns its actors: a boost or favourite moves what another test reads.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
// The dev server's own asset, so the image loads.
const imageUrl = new URL('/default_avatar.webp', BASE_URL).href
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
// The home timeline's page size (useActivityPub loadTimeline).
const PAGE_SIZE = 20
// Timeline views compile on a cold dev server's first visit.
const APP_LOAD_MS = 90_000

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Inserts posts. create_comprehensive_timeline_entries fans a public post out to
 * every local profile, which races a profile another spec deletes meanwhile
 * (timeline_entries_user_id_fkey); the insert is atomic and is retried.
 */
async function insertPosts(rows: Record<string, unknown>[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.from('posts').insert(rows)
    if (!error) return
    if (attempt < 4 && error.message.includes('timeline_entries_user_id_fkey')) continue
    throw new Error(`posts: ${error.message}`)
  }
}

interface Feed {
  reader: SpecUser
  author: SpecUser
  texts: string[]
}

/** A reader following one author whose `count` public posts, a minute apart, fill the home timeline. */
async function seedFeed(tag: string, count: number): Promise<Feed> {
  const reader = await createUser(admin, `${tag}r`)
  const author = await createUser(admin, `${tag}a`)
  const { error: followError } = await admin
    .from('follows')
    .insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)
  const now = Date.now()
  const texts = Array.from({ length: count }, (_, i) => `${tag} post ${i + 1} by ${author.username}`)
  await insertPosts(
    texts.map((text, i) => ({
      author_id: author.id,
      visibility: 'public',
      is_local: true,
      content: [{ type: 'text', text }],
      created_at: new Date(now - (i + 1) * 60_000).toISOString(),
    })),
  )
  return { reader, author, texts }
}

async function dropFeed(feed: Feed | undefined) {
  if (!feed) return
  await deleteUser(admin, feed.reader)
  await deleteUser(admin, feed.author)
}

async function openHome(page: Page) {
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  const feed = page.getByRole('feed', { name: 'Home timeline' })
  await expect(feed.locator('article[aria-posinset="1"]')).toBeVisible({ timeout: APP_LOAD_MS })
  return feed
}

const polite = (page: Page) => page.getByTestId('live-announcer-polite')

test('the home timeline is a feed read post by post from the keyboard', async ({ page }) => {
  test.setTimeout(240_000)
  let seeded: Feed | undefined
  try {
    seeded = await seedFeed('fd', PAGE_SIZE + 5)
    const { reader, author } = seeded
    await signIn(page, reader)
    const feed = await openHome(page)
    const article = (n: number) => feed.locator(`article[aria-posinset="${n}"]`)

    await test.step('articles are named by author and time, carry positions and a heading', async () => {
      const name = new RegExp(`^${escapeRe(author.displayName)}, \\d+ minutes? ago$`)
      await expect(article(1)).toHaveAccessibleName(name)
      await expect(article(1)).toHaveAttribute('aria-setsize', '-1')
      await expect(article(1).getByRole('heading', { level: 3 })).toHaveText(name)
      await expect(article(1)).toContainText(seeded!.texts[0])
      await expect(article(2)).toContainText(seeded!.texts[1])
      // The visible "1m" is the short form; the link reads the full date.
      await expect(article(1).locator('.post-time')).toHaveAccessibleName(/\d{4}/)
    })

    await test.step('PageDown/PageUp and j/k move focus between articles', async () => {
      await article(1).focus()
      await page.keyboard.press('PageDown')
      await expect(article(2)).toBeFocused()
      await page.keyboard.press('j')
      await expect(article(3)).toBeFocused()
      await page.keyboard.press('k')
      await expect(article(2)).toBeFocused()
      await page.keyboard.press('PageUp')
      await expect(article(1)).toBeFocused()
      // From a control inside a post as well.
      await article(1).getByRole('button', { name: /^Favorite/ }).focus()
      await page.keyboard.press('PageDown')
      await expect(article(2)).toBeFocused()
    })

    await test.step('Ctrl+End reaches Load more; loading announces and focuses the first new post', async () => {
      await page.keyboard.press('Control+End')
      const loadMore = page.getByTestId('feed-load-more')
      await expect(loadMore).toBeFocused()
      await expect(loadMore).toHaveText(/Load more posts|Loading more posts/)
      await page.keyboard.press('Enter')
      await expect(polite(page)).toContainText('5 posts loaded', { timeout: 30000 })
      await expect(article(PAGE_SIZE + 1)).toBeFocused({ timeout: 15000 })
      await expect(article(PAGE_SIZE + 1)).toContainText(seeded!.texts[PAGE_SIZE])
      // Everything is loaded: the set size is known and Load more is gone.
      await expect(article(PAGE_SIZE + 1)).toHaveAttribute('aria-setsize', String(PAGE_SIZE + 5))
      await expect(loadMore).toHaveCount(0)
    })

    await test.step('the focused post stays rendered while scrolled out of the window', async () => {
      const scroller = page.locator('[data-testid="timeline-feed"] .posts-container')
      await scroller.evaluate((el) => { el.scrollTop = 0 })
      await expect(article(1)).toBeVisible()
      await article(1).focus()
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
      await expect(article(PAGE_SIZE + 5)).toBeVisible()
      await expect(article(1)).toBeAttached()
      await expect(article(1)).toBeFocused()
    })
  } finally {
    await dropFeed(seeded)
  }
})

test("a post's More menu opens, moves and acts from the keyboard", async ({ page }) => {
  test.setTimeout(180_000)
  let seeded: Feed | undefined
  try {
    seeded = await seedFeed('mn', 2)
    const { reader, author } = seeded
    await signIn(page, reader)
    const feed = await openHome(page)
    const post = feed.locator('article[aria-posinset="1"]')
    const more = post.getByRole('button', { name: 'More options' })
    const menu = page.getByRole('menu', { name: 'More options' })

    await test.step('Enter opens the menu with focus on its first item', async () => {
      await expect(more).toHaveAttribute('aria-haspopup', 'menu')
      await expect(more).toHaveAttribute('aria-expanded', 'false')
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(menu).toBeVisible()
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeFocused()
    })

    await test.step('arrows, Home/End move inside it; Escape returns focus to the button', async () => {
      await page.keyboard.press('ArrowDown')
      await expect(menu.getByRole('menuitem', { name: `Mute @${author.username}` })).toBeFocused()
      await page.keyboard.press('End')
      await expect(menu.getByRole('menuitem', { name: 'Report post' })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(more).toBeFocused()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
    })

    await expectNoAxeViolations(page, { label: 'feed with closed menu' })

    await test.step('ArrowUp opens on the last item', async () => {
      await page.keyboard.press('ArrowUp')
      await expect(menu.getByRole('menuitem', { name: 'Report post' })).toBeFocused()
      await expectNoAxeViolations(page, { include: '[role="menu"]', label: 'post menu' })
      await page.keyboard.press('Escape')
      await expect(more).toBeFocused()
    })

    await test.step('Copy link acts, confirms and hands focus back', async () => {
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {} })
      })
      await page.keyboard.press('Enter')
      await expect(menu.getByRole('menuitem', { name: 'Copy link' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu).toBeHidden()
      await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Link copied' })).toBeVisible()
      await expect(more).toBeFocused()
    })
  } finally {
    await dropFeed(seeded)
  }
})

test('boost and favourite are toggles with fixed names, counts and pressed state', async ({ page }) => {
  test.setTimeout(240_000)
  let seeded: Feed | undefined
  try {
    seeded = await seedFeed('bf', 1)
    const { reader } = seeded
    const text = seeded.texts[0]
    await signIn(page, reader)
    await openHome(page)
    const post = page.locator('[data-testid="post-item"]:not(.is-reblog)').filter({ hasText: text }).first()
    const favourite = post.locator('[data-testid="post-favorite-btn"]')
    const boost = post.locator('[data-testid="post-reblog-btn"]')

    await test.step('favourite toggles from the keyboard; its name carries the count', async () => {
      await expect(favourite).toHaveAccessibleName('Favorite')
      await expect(favourite).toHaveAttribute('aria-pressed', 'false')
      await favourite.focus()
      await page.keyboard.press('Enter')
      await expect(favourite).toHaveAttribute('aria-pressed', 'true')
      await expect(favourite).toHaveAccessibleName('Favorite, 1')
      await page.keyboard.press('Space')
      await expect(favourite).toHaveAttribute('aria-pressed', 'false')
      await expect(favourite).toHaveAccessibleName('Favorite')
    })

    await test.step('boost is a toggle, not also a disclosure; Enter opens its menu on Boost', async () => {
      await expect(boost).toHaveAccessibleName('Boost')
      await expect(boost).toHaveAttribute('aria-pressed', 'false')
      expect(await boost.getAttribute('aria-expanded')).toBeNull()
      await boost.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu', { name: 'Boost' })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Boost' })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(menu.getByRole('menuitem', { name: 'Quote' })).toBeFocused()
      await page.keyboard.press('ArrowUp')

      const boostWritten = page.waitForResponse(
        (response) => response.url().includes('/rest/v1/posts') && response.request().method() === 'POST',
        { timeout: 30000 },
      )
      await page.keyboard.press('Enter')
      await boostWritten
      await expect(menu).toBeHidden()
      await expect(boost).toBeFocused()
    })

    await test.step('after a reload the boost reads pressed with its count', async () => {
      // Counts reach an open timeline over realtime, absent from this stack.
      await expect(async () => {
        await page.reload()
        await expect(post).toBeVisible({ timeout: 30000 })
        await expect(boost).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 })
        await expect(boost).toHaveAccessibleName('Boost, 1', { timeout: 5000 })
      }).toPass({ timeout: 90000, intervals: [2000, 3000, 5000] })
    })
  } finally {
    await dropFeed(seeded)
  }
})

test('profile tabs and a follow request answered from the keyboard', async ({ page }) => {
  test.setTimeout(180_000)
  const owner = await createUser(admin, 'tabo')
  const fan = await createUser(admin, 'tabf')
  try {
    await admin.from('profiles').update({ manually_approves_followers: true }).eq('id', owner.id)
    const { error } = await admin
      .from('follows')
      .insert({ follower_id: fan.id, following_id: owner.id, status: 'pending' })
    if (error) throw new Error(`follow request: ${error.message}`)

    await signIn(page, owner)

    await test.step('profile sections are a tablist with manual activation', async () => {
      await page.goto(`/social/profile/${owner.username}`)
      await dismissAnnouncements(page)
      const tabs = page.getByRole('tablist', { name: 'Profile sections' })
      await expect(tabs).toBeVisible({ timeout: APP_LOAD_MS })
      const posts = tabs.getByRole('tab', { name: /^Posts/ })
      const media = tabs.getByRole('tab', { name: /^Media/ })
      await expect(posts).toHaveAttribute('aria-selected', 'true')
      await expect(posts).toHaveAttribute('tabindex', '0')
      await expect(media).toHaveAttribute('tabindex', '-1')
      await expect(page.getByRole('tabpanel', { name: /^Posts/ })).toBeVisible()

      await posts.focus()
      await page.keyboard.press('ArrowRight')
      await expect(media).toBeFocused()
      await expect(media).toHaveAttribute('aria-selected', 'false')
      await page.keyboard.press('Enter')
      await expect(media).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('tabpanel', { name: /^Media/ })).toBeVisible()
      await page.keyboard.press('End')
      await expect(tabs.getByRole('tab', { name: /^Followers/ })).toBeFocused()
      await page.keyboard.press('Home')
      await expect(posts).toBeFocused()
    })

    await test.step('the request is accepted from a button named with the requester', async () => {
      await page.goto('/social/follow-requests')
      await dismissAnnouncements(page)
      const tabs = page.getByRole('tablist', { name: 'Follow requests' })
      await expect(tabs).toBeVisible({ timeout: APP_LOAD_MS })
      const requestsTab = tabs.getByRole('tab', { name: /^Requests/ })
      await expect(requestsTab).toHaveAttribute('aria-selected', 'true')

      const accept = page.getByRole('button', { name: `Accept follow request from ${fan.displayName}` })
      await expect(accept).toBeVisible({ timeout: 30000 })
      await expect(page.getByRole('button', { name: `Decline follow request from ${fan.displayName}` })).toBeVisible()
      await accept.focus()
      await page.keyboard.press('Enter')

      await expect
        .poll(async () => {
          const { data } = await admin
            .from('follows')
            .select('status')
            .eq('follower_id', fan.id)
            .eq('following_id', owner.id)
            .maybeSingle()
          return data?.status ?? null
        }, { timeout: 15000 })
        .toBe('accepted')
      // The answered row is gone with the button that held focus.
      await expect(requestsTab).toBeFocused()
      await expect(polite(page)).toContainText('No pending requests')
    })

    await expectNoAxeViolations(page, { label: 'follow requests' })
  } finally {
    await deleteUser(admin, fan)
    await deleteUser(admin, owner)
  }
})

test('the composer dialog: visibility menu by keyboard and an image posted with alt text', async ({ page }) => {
  test.setTimeout(240_000)
  const writer = await createUser(admin, 'cmp')
  const text = `composer a11y ${writer.username}`
  const alt = `a single transparent pixel for ${writer.username}`
  try {
    await signIn(page, writer)
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    const newPost = page.getByRole('button', { name: 'New post' })
    await expect(newPost).toBeVisible({ timeout: APP_LOAD_MS })

    const dialog = page.getByRole('dialog', { name: 'Create a post' })

    await test.step('New post opens a modal dialog with focus in the editor', async () => {
      await newPost.focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible({ timeout: 15000 })
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      await expect(dialog.locator('.rich-text-editor')).toBeFocused()
      await page.keyboard.type(text)
    })

    await test.step('visibility is a menu of radio items reached and set from the keyboard', async () => {
      const chip = dialog.getByRole('button', { name: 'Visibility: Public' })
      await chip.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu', { name: 'Post visibility' })
      await expect(menu).toBeVisible()
      const publicItem = menu.getByRole('menuitemradio', { name: /^Public/ })
      await expect(publicItem).toBeFocused()
      await expect(publicItem).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      const followers = menu.getByRole('menuitemradio', { name: /^Followers only/ })
      await expect(followers).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu).toBeHidden()
      const changed = dialog.getByRole('button', { name: 'Visibility: Followers only' })
      await expect(changed).toBeFocused()

      // Escape closes the menu and leaves the dialog open.
      await page.keyboard.press('Enter')
      await expect(menu.getByRole('menuitemradio', { name: /^Followers only/ })).toBeFocused()
      await expect(menu.getByRole('menuitemradio', { name: /^Followers only/ })).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(dialog).toBeVisible()
      await expect(changed).toBeFocused()
    })

    await test.step('an attached image gets its alt text from the keyboard', async () => {
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG })
      const altButton = dialog.getByRole('button', { name: 'ALT text for pixel.png' })
      await expect(altButton).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Edit pixel.png' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Remove pixel.png' })).toBeVisible()
      await altButton.focus()
      await page.keyboard.press('Enter')
      const altInput = page.getByTestId('media-alt-input')
      await expect(altInput).toBeFocused({ timeout: 15000 })
      await page.keyboard.type(alt)
      await page.getByTestId('media-edit-save').focus()
      await page.keyboard.press('Enter')
      await expect(altInput).toBeHidden()
      await expect(altButton).toBeFocused()
    })

    await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'composer dialog' })

    await test.step('posting from the keyboard stores the visibility and the description', async () => {
      await dialog.getByTestId('compose-submit').focus()
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden({ timeout: 30000 })
      await expect(newPost).toBeFocused()
      await expect
        .poll(async () => {
          const { data } = await admin
            .from('posts')
            .select('visibility, media_attachments')
            .eq('author_id', writer.id)
            .maybeSingle()
          if (!data) return null
          const media = (data.media_attachments as Array<{ description?: string }> | null) ?? []
          return { visibility: data.visibility, description: media[0]?.description ?? null }
        }, { timeout: 30000 })
        .toEqual({ visibility: 'followers', description: alt })
    })
  } finally {
    await deleteUser(admin, writer)
  }
})

test('sensitive media stays out of reach until revealed from the keyboard', async ({ page }) => {
  test.setTimeout(180_000)
  const reader = await createUser(admin, 'senr')
  const author = await createUser(admin, 'sena')
  const text = `sensitive pixel ${author.username}`
  const description = `a grey avatar for ${author.username}`
  try {
    const { error } = await admin.from('follows').insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
    if (error) throw new Error(`follow: ${error.message}`)
    await insertPosts([{
      author_id: author.id,
      visibility: 'public',
      is_local: true,
      is_sensitive: true,
      content: [{ type: 'text', text }],
      media_attachments: [{ type: 'Image', mediaType: 'image/webp', url: imageUrl, description }],
    }])

    await signIn(page, reader)
    await openHome(page)
    const post = page.locator('[data-testid="post-item"]').filter({ hasText: text })
    const reveal = post.getByRole('button', { name: /^Sensitive content/ })

    await test.step('hidden media is not in the accessibility tree and cannot take focus', async () => {
      await expect(reveal).toBeVisible()
      await expect(post.getByRole('img', { name: description })).toHaveCount(0)
      await expect(post.getByRole('button', { name: description })).toHaveCount(0)
      await expect(post.locator('.media-item')).toHaveAttribute('inert', '')
      // The reveal button precedes the media in reading order.
      const order = await post.locator('.media-gallery').evaluate((gallery) =>
        Array.from(gallery.children).map((el) => el.className.split(' ')[0]),
      )
      expect(order[0]).toBe('sensitive-overlay')
    })

    await test.step('revealing moves focus to Hide media; the tile is one button named by its description', async () => {
      await reveal.focus()
      await page.keyboard.press('Enter')
      const hide = post.getByRole('button', { name: 'Hide media' })
      await expect(hide).toBeFocused()
      const tile = post.getByRole('button', { name: description })
      await expect(tile).toBeVisible()
      await expect(tile.getByRole('button')).toHaveCount(0)
      await tile.focus()
      await page.keyboard.press('Space')
      const viewer = page.getByRole('dialog', { name: /Media viewer/ })
      await expect(viewer).toBeVisible({ timeout: 10000 })
      await expect(viewer.getByRole('img', { name: description })).toBeVisible()
    })
  } finally {
    await deleteUser(admin, reader)
    await deleteUser(admin, author)
  }
})

test('the user search dialog is labelled, announces results and has pressed filters', async ({ page }) => {
  test.setTimeout(180_000)
  const searcher = await createUser(admin, 'srch')
  const target = await createUser(admin, 'srcht')
  try {
    await signIn(page, searcher)
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    const searchButton = page.locator('.mony-header').getByRole('button', { name: 'Search' })
    await expect(searchButton).toBeVisible({ timeout: APP_LOAD_MS })
    await searchButton.focus()
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Search users' })
    await expect(dialog).toBeVisible()
    const field = dialog.getByRole('searchbox', { name: 'Search users' })
    await expect(field).toBeFocused()

    await test.step('results are announced', async () => {
      await page.keyboard.type(target.username)
      await expect(polite(page)).toContainText('1 user found', { timeout: 15000 })
      await expect(dialog.getByRole('button', { name: target.displayName, exact: true })).toBeVisible()
    })

    await test.step('filters are pressed toggles', async () => {
      const all = dialog.getByRole('button', { name: 'All', exact: true })
      const local = dialog.getByRole('button', { name: 'Local', exact: true })
      await expect(all).toHaveAttribute('aria-pressed', 'true')
      await expect(local).toHaveAttribute('aria-pressed', 'false')
      await local.focus()
      await page.keyboard.press('Enter')
      await expect(local).toHaveAttribute('aria-pressed', 'true')
      await expect(all).toHaveAttribute('aria-pressed', 'false')
    })

    // The filter buttons animate their colours for 0.2 s; axe reads the settled state.
    await page.waitForTimeout(400)
    await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'user search dialog' })

    await test.step('Escape closes it and focus returns to Search', async () => {
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(searchButton).toBeFocused()
    })
  } finally {
    await deleteUser(admin, target)
    await deleteUser(admin, searcher)
  }
})

test('axe: social screens', async ({ page }) => {
  test.setTimeout(300_000)
  let seeded: Feed | undefined
  try {
    seeded = await seedFeed('ax', 3)
    const { reader, author } = seeded
    const { data: first } = await admin
      .from('posts')
      .select('id')
      .eq('author_id', author.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    await insertPosts([{
      author_id: reader.id,
      visibility: 'public',
      is_local: true,
      in_reply_to: first!.id,
      content: [{ type: 'text', text: `reply by ${reader.username}` }],
    }])
    await admin.from('follows').insert({ follower_id: author.id, following_id: reader.id, status: 'accepted' })
    const { data: list } = await admin.from('user_lists').insert({ user_id: reader.id, title: `List ${reader.username}` }).select('id').single()
    await admin.from('user_list_members').insert({ list_id: list!.id, account_id: author.id })

    await signIn(page, reader)

    const screens: Array<[string, string, (p: Page) => Promise<void>]> = [
      ['/social/local', 'local timeline', async (p) => {
        await expect(p.getByRole('feed', { name: 'Local timeline' }).locator('article').first()).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      ['/social/home', 'home timeline', async (p) => {
        await expect(p.getByRole('feed', { name: 'Home timeline' }).locator('article').first()).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      [`/social/post/${first!.id}`, 'post detail', async (p) => {
        await expect(p.locator('article[aria-current="true"]')).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      [`/social/profile/${author.username}`, 'profile', async (p) => {
        await expect(p.getByRole('tablist', { name: 'Profile sections' })).toBeVisible({ timeout: APP_LOAD_MS })
        await expect(p.locator('article').first()).toBeVisible({ timeout: 30000 })
      }],
      ['/social/followers', 'followers', async (p) => {
        await expect(p.getByRole('tabpanel').locator('.user-item').first()).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      ['/social/lists', 'lists', async (p) => {
        await expect(p.getByRole('link', { name: `List ${reader.username}` })).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      [`/social/lists/${list!.id}`, 'list detail', async (p) => {
        await expect(p.getByRole('button', { name: 'Back to lists' })).toBeVisible({ timeout: APP_LOAD_MS })
      }],
      ['/social/trending', 'trending', async (p) => {
        await expect(p.getByRole('tablist', { name: 'Trending sections' })).toBeVisible({ timeout: APP_LOAD_MS })
      }],
    ]
    for (const [path, label, ready] of screens) {
      await page.goto(path)
      await dismissAnnouncements(page)
      await ready(page)
      await page.waitForTimeout(1000)
      await expectNoAxeViolations(page, { label })
    }

    await test.step('the thread marks the opened post and nests no article', async () => {
      await page.goto(`/social/post/${first!.id}`)
      const opened = page.locator('article[aria-current="true"]')
      await expect(opened).toBeVisible({ timeout: APP_LOAD_MS })
      await expect(opened).toHaveAccessibleName(/, opened post$/)
      await expect(page.getByRole('article', { name: /reply to / })).toBeVisible({ timeout: 30000 })
      expect(await page.locator('article article').count()).toBe(0)
    })

    await test.step('the social navigation has no nested landmark and marks the current page', async () => {
      const nav = page.getByRole('navigation', { name: 'Social navigation' })
      await expect(nav.getByRole('navigation')).toHaveCount(0)
      await page.goto('/social/bookmarks')
      await expect(nav.getByRole('link', { name: 'Bookmarks' })).toHaveAttribute('aria-current', 'page', { timeout: APP_LOAD_MS })
      await expect(nav.getByRole('link', { name: /Following/ })).toBeVisible()
    })
  } finally {
    await dropFeed(seeded)
  }
})
