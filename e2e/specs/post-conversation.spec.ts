// Journeys: a post's page is the post with its ancestors and all of its replies, and every
// link to another post loads that post, on the same view. A reply opened from its
// notification shows its own branch, and a bar above the thread opens the conversation's top
// post with every reply and that reply highlighted. A timestamp anywhere in the thread opens
// that post's own page. The reply button keeps its size while the reply is sent.
//
// The conversation: the reader's root, two replies to it and a reply to the first.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let replier: SpecUser
const marker = Date.now().toString(36)
const ids = { root: '', first: '', second: '', deep: '' }
const text = {
  root: `conversation root ${marker}`,
  first: `first answer ${marker}`,
  second: `second answer ${marker}`,
  deep: `answer to the first ${marker}`,
}

async function insertPost(row: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await admin.from('posts').insert(row).select('id').single()
    if (!error && data) return data.id as string
    if (attempt < 4 && error?.message.includes('timeline_entries_user_id_fkey')) continue
    throw new Error(`posts: ${error?.message}`)
  }
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'pcvr')
  replier = await createUser(admin, 'pcvp')
  const start = Date.now() - 30 * 60_000
  const post = (author: SpecUser, body: string, parent: string | null, minute: number) => insertPost({
    author_id: author.id,
    visibility: 'public',
    is_local: true,
    content: [{ type: 'text', text: body }],
    in_reply_to: parent,
    created_at: new Date(start + minute * 60_000).toISOString(),
  })
  ids.root = await post(reader, text.root, null, 0)
  ids.first = await post(replier, text.first, ids.root, 1)
  ids.second = await post(replier, text.second, ids.root, 2)
  ids.deep = await post(replier, text.deep, ids.first, 3)
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [reader?.id, replier?.id].filter(Boolean))
  await deleteUser(admin, reader)
  await deleteUser(admin, replier)
})

const opened = (page: Page) => page.locator('.post-view article[aria-current="true"]')
const threadPosts = (page: Page) => page.locator('.post-view .thread-post')
const threadPost = (page: Page, body: string) => threadPosts(page).filter({ hasText: body })
const postUrl = (id: string) => new RegExp(`/social/post/${id}(\\?|$)`)

async function expectThread(page: Page, main: string, shown: string[], hidden: string[] = []) {
  await expect(opened(page)).toContainText(main, { timeout: 90_000 })
  await expect(threadPosts(page)).toHaveCount(shown.length)
  for (const body of shown) await expect(threadPost(page, body)).toHaveCount(1)
  for (const body of hidden) await expect(threadPost(page, body)).toHaveCount(0)
}

test('a reply opened from its notification leads to the whole conversation', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)

  // On a post page already: the notification reuses the view.
  await page.goto(`/social/post/${ids.second}`)
  await expectThread(page, text.second, [text.root, text.second], [text.first])

  await page.locator('[data-testid="notification-bell"]').click()
  const panel = page.locator('[data-testid="notification-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })
  const notification = panel.locator('[data-testid="notification-item"][data-type="activitypub_reply"]').filter({ hasText: text.first })
  await notification.locator('[data-row-hit]').click()

  await expect(page).toHaveURL(postUrl(ids.first), { timeout: 15000 })
  await expectThread(page, text.first, [text.root, text.first, text.deep], [text.second])

  const bar = page.getByTestId('post-view-conversation-bar')
  await expect(bar).toContainText('4 posts in this conversation')
  await bar.getByRole('link', { name: 'View full conversation' }).click()

  await expect(page).toHaveURL(new RegExp(`/social/post/${ids.root}\\?highlight=${ids.first}`))
  await expectThread(page, text.root, [text.root, text.first, text.deep, text.second])
  await expect(bar).toHaveCount(0)
  const highlighted = page.locator('.post-view .thread-post.highlighted-post')
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toContainText(text.first)
  await expect(highlighted).toBeInViewport()
})

test('a timestamp in the thread opens that post with all of its replies', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${ids.deep}`)
  await expectThread(page, text.deep, [text.root, text.first, text.deep], [text.second])

  await threadPost(page, text.root).locator('a.post-time').click()
  await expect(page).toHaveURL(postUrl(ids.root))
  await expectThread(page, text.root, [text.root, text.first, text.deep, text.second])

  await threadPost(page, text.second).locator('a.post-time').click()
  await expect(page).toHaveURL(postUrl(ids.second))
  await expectThread(page, text.second, [text.root, text.second], [text.first])

  await threadPost(page, text.root).locator('a.post-time').click()
  await expect(page).toHaveURL(postUrl(ids.root))
  await expectThread(page, text.root, [text.root, text.first, text.deep, text.second])

  // The opened post's own time drops the highlight and keeps every reply.
  await page.goto(`/social/post/${ids.root}?highlight=${ids.deep}`)
  await expectThread(page, text.root, [text.root, text.first, text.deep, text.second])
  await opened(page).locator('a.detail-time').click()
  await expect(page).toHaveURL(postUrl(ids.root))
  await expect(page.locator('.post-view .thread-post.highlighted-post')).toHaveCount(0)
  await expectThread(page, text.root, [text.root, text.first, text.deep, text.second])
})

test('the reply button keeps its size while the reply is sent', async ({ page }) => {
  test.setTimeout(180_000)
  // French: "Réponse en cours..." is far longer than "Répondre". The profile's locale wins
  // over the browser's.
  const { error } = await admin.from('profiles').update({ locale: 'fr' }).eq('id', reader.id)
  if (error) throw new Error(`locale: ${error.message}`)
  await page.setViewportSize({ width: 375, height: 812 })
  try {
    await sendReplyHeld(page)
  } finally {
    await admin.from('profiles').update({ locale: 'en' }).eq('id', reader.id)
  }
})

async function sendReplyHeld(page: Page) {
  await signIn(page, reader)
  await page.goto(`/social/post/${ids.first}`)
  await expect(opened(page)).toContainText(text.first, { timeout: 90_000 })

  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/posts*', async (route) => {
    if (route.request().method() === 'POST') await held
    await route.continue()
  })

  await opened(page).getByTestId('post-reply-btn').click()
  const composer = opened(page).getByTestId('compose-post')
  const submit = composer.getByTestId('compose-submit')
  await expect(submit).toBeEnabled({ timeout: 15000 })
  await expect(submit).toHaveText('Répondre')
  const idle = (await submit.boundingBox())!

  await submit.click()
  await expect(submit).toHaveAttribute('aria-busy', 'true')
  await expect(submit).toHaveText('Répondre')
  const busy = (await submit.boundingBox())!
  expect(Math.abs(busy.width - idle.width)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(busy.height - idle.height)).toBeLessThanOrEqual(0.5)
  const edge = await composer.evaluate((el) => el.getBoundingClientRect().right)
  expect(busy.x + busy.width).toBeLessThanOrEqual(edge + 0.5)
  await expect(submit.locator('.post-button-spinner')).toBeVisible()

  release()
  await expect(submit).toHaveCount(0, { timeout: 15000 })
}
