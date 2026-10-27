// Journey: a message that is only a link to a GIF page (Klipy, Tenor, Giphy) shows the GIF
// alone, as Discord shows a lone GIF link. The link stays in the message for those who need
// it: screen readers read it, keyboard focus shows it, Copy text and edit mode hold it. Text
// beside the link keeps both, a lone link to any other page keeps its text, and a GIF that
// does not load gives its link back.
//
// The stack runs no federation backend: previews are written into message metadata as the
// backend's enrichment writes them, keyed by the stored link.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const KLIPY_PAGE = 'https://klipy.com/gifs/old-man-yells-at-cloud'
const KLIPY_GIF = 'https://static.klipy.test/ii/abc/de/fg/old-man-yells.gif'
const TENOR_PAGE = 'https://tenor.com/view/cat-typing-gif-12002364'
const TENOR_MP4 = 'https://media.tenor.test/m/cat-typing.mp4'
const BESIDE_PAGE = 'https://klipy.com/gifs/thumbs-up'
const BESIDE_GIF = 'https://static.klipy.test/ii/abc/de/fg/thumbs-up.gif'
const BLOG_PAGE = 'https://blog.example.test/posts/dancing'
const BLOG_GIF = 'https://blog.example.test/media/dancing.gif'
const GONE_PAGE = 'https://giphy.com/gifs/gone-xT9IgG50Fb7Mi0prBC'
const GONE_GIF = 'https://media.giphy.test/media/gone/giphy.gif'

const GIF_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0ea5e9"/></svg>'
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))
const ids: Record<'klipy' | 'tenor' | 'beside' | 'blog' | 'gone', string> = { klipy: '', tenor: '', beside: '', blog: '', gone: '' }

const payload = (url: string, over: Record<string, unknown>) => ({
  cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'generic',
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over,
})

async function post(content: unknown[], embeds: Record<string, unknown>, at: number): Promise<string> {
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content,
    metadata: { embeds },
    created_at: new Date(at).toISOString(),
  }).select('id').single()
  if (error || !data) throw new Error(`message: ${error?.message}`)
  return data.id
}

test.beforeAll(async () => {
  user = await createUser(admin, 'gifl')
  server = await seedServer(admin, user, `GIF links ${user.username}`)
  const t0 = Date.now() - 60_000
  ids.klipy = await post([{ type: 'url', url: KLIPY_PAGE, preview: true }], {
    [KLIPY_PAGE]: payload(KLIPY_PAGE, { title: 'Old Man Yells At Cloud', siteName: 'Klipy', image: KLIPY_GIF, mediaOnly: true }),
  }, t0)
  ids.tenor = await post([{ type: 'text', text: ' ' }, { type: 'url', url: TENOR_PAGE, preview: true }], {
    [TENOR_PAGE]: payload(TENOR_PAGE, { title: 'Cat Typing GIF', siteName: 'Tenor', image: TENOR_MP4, mediaOnly: true }),
  }, t0 + 1000)
  ids.beside = await post([{ type: 'text', text: 'agreed ' }, { type: 'url', url: BESIDE_PAGE, preview: true }], {
    [BESIDE_PAGE]: payload(BESIDE_PAGE, { title: 'Thumbs Up', siteName: 'Klipy', image: BESIDE_GIF, mediaOnly: true }),
  }, t0 + 2000)
  ids.blog = await post([{ type: 'url', url: BLOG_PAGE, preview: true }], {
    [BLOG_PAGE]: payload(BLOG_PAGE, { title: 'Dancing', siteName: 'A blog', image: BLOG_GIF, mediaOnly: true }),
  }, t0 + 3000)
  ids.gone = await post([{ type: 'url', url: GONE_PAGE, preview: true }], {
    [GONE_PAGE]: payload(GONE_PAGE, { title: 'Gone', siteName: 'GIPHY', image: GONE_GIF, mediaOnly: true }),
  }, t0 + 4000)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function serveMedia(page: Page) {
  for (const pattern of ['https://static.klipy.test/**', 'https://blog.example.test/media/**']) {
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: GIF_BODY }))
  }
  await page.route('https://media.giphy.test/**', (route) => route.fulfill({ status: 404, body: '' }))
  await page.route('https://media.tenor.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } }))
}

const row = (page: Page, id: string) => messageList(page).locator(`.message-item[data-message-id="${id}"]`)

/** Width of the element's box: 1px or less for visually hidden content. */
const shownWidth = async (l: Locator) => (await l.boundingBox())?.width ?? 0

test('a message that is only a GIF link shows the GIF alone, and the link stays reachable', async ({ page }) => {
  test.setTimeout(150_000)
  await serveMedia(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)

  const klipy = row(page, ids.klipy)
  await expect(klipy.locator(`img[src="${KLIPY_GIF}"]`)).toBeVisible({ timeout: 30000 })

  await test.step('the link text is not shown; the GIF is the message', async () => {
    const link = klipy.getByRole('link', { name: KLIPY_PAGE })
    await expect(link).toHaveCount(1)
    await expect(link).toHaveAttribute('href', KLIPY_PAGE)
    expect(await shownWidth(link)).toBeLessThanOrEqual(1)
    const gif = (await klipy.locator(`img[src="${KLIPY_GIF}"]`).boundingBox())!
    const content = (await klipy.locator('.unified-content').boundingBox())!
    expect(gif.y - content.y).toBeLessThanOrEqual(8)
  })

  await test.step('keyboard focus shows the link', async () => {
    const link = klipy.getByRole('link', { name: KLIPY_PAGE })
    await link.focus()
    await expect(link).toBeFocused()
    expect(await shownWidth(link)).toBeGreaterThan(100)
    await link.blur()
  })

  await test.step('a Tenor link answering with a looping video shows the video alone', async () => {
    const tenor = row(page, ids.tenor)
    await expect(tenor.locator(`video[src="${TENOR_MP4}"]`)).toBeAttached()
    const link = tenor.getByRole('link', { name: TENOR_PAGE })
    await expect(link).toHaveCount(1)
    expect(await shownWidth(link)).toBeLessThanOrEqual(1)
  })

  await test.step('Copy text and Copy Link URL hold the link', async () => {
    await klipy.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Message options' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy text' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(KLIPY_PAGE)

    await page.evaluate(() => navigator.clipboard.writeText(''))
    await klipy.focus()
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'Copy Link URL' }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(KLIPY_PAGE)
  })

  await test.step('edit mode holds the link', async () => {
    await klipy.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Message options' })
    await menu.getByRole('menuitem', { name: 'Edit message' }).click()
    const editor = klipy.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText(KLIPY_PAGE)
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
  })

  await test.step('text beside a GIF link keeps the text, the link and the GIF', async () => {
    const beside = row(page, ids.beside)
    await expect(beside.locator(`img[src="${BESIDE_GIF}"]`)).toBeVisible()
    await expect(beside).toContainText('agreed')
    const link = beside.getByRole('link', { name: BESIDE_PAGE })
    expect(await shownWidth(link)).toBeGreaterThan(100)
  })

  await test.step('a lone link to a page that is not a GIF host keeps its text', async () => {
    const blog = row(page, ids.blog)
    await expect(blog.locator(`img[src="${BLOG_GIF}"]`)).toBeVisible()
    expect(await shownWidth(blog.getByRole('link', { name: BLOG_PAGE }))).toBeGreaterThan(100)
  })

  await test.step('a lone GIF link whose GIF does not load shows its link', async () => {
    const link = row(page, ids.gone).getByRole('link', { name: GONE_PAGE })
    await expect.poll(() => shownWidth(link)).toBeGreaterThan(100)
  })
})
