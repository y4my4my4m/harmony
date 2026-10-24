// Journey: a post shows a picture once. A GIF from the GIF picker is a link in the text, drawn
// inline; the backend's preview of that link (media-only, titled with the host) drew a second
// copy as a card. A post's attachment linked in its own text drew a card beside the gallery.
// A link to a page keeps its card, and so does a GIF link beside an attachment: the gallery
// takes media links out of the text, the card is what shows it.
//
// The stack runs no federation backend: previews are written into post metadata as its
// enrichment writes them.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let author: SpecUser
const ids: Record<'gif' | 'attachment' | 'gifBesideAttachment' | 'page', string> = { gif: '', attachment: '', gifBesideAttachment: '', page: '' }

const GIF = 'https://static.klipy.test/ii/abc/de/fg/old-man-yells.gif'
const PHOTO = 'https://media.preview.test/photos/cloud.png'
const PAGE = 'https://news.preview.test/articles/old-man-yells-at-cloud'
// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const preview = (url: string, extra: Record<string, unknown>) => ({
  cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'generic', fetchedAt: new Date().toISOString(), ...extra,
})

async function seedPost(content: unknown[], embeds: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin.from('posts').insert({
    author_id: author.id,
    is_local: true,
    visibility: 'public',
    content,
    metadata: { embeds },
    ...extra,
  }).select('id').single()
  if (error) throw new Error(`post: ${error.message}`)
  return data!.id
}

test.beforeAll(async () => {
  author = await createUser(admin, 'pmp')
  const host = (u: string) => new URL(u).host
  ids.gif = await seedPost(
    [{ type: 'url', url: GIF, preview: true }, { type: 'text', text: ' Cloudflare!!!...' }],
    { [GIF]: preview(GIF, { title: host(GIF), siteName: host(GIF), image: GIF, mediaOnly: true }) },
  )
  ids.attachment = await seedPost(
    [{ type: 'text', text: 'the cloud again ' }, { type: 'url', url: PHOTO, preview: true }],
    { [PHOTO]: preview(PHOTO, { title: host(PHOTO), siteName: host(PHOTO), image: PHOTO, mediaOnly: true }) },
    { media_attachments: [{ type: 'image', url: PHOTO, description: 'a cloud' }] },
  )
  ids.gifBesideAttachment = await seedPost(
    [{ type: 'text', text: 'cloud and a reaction ' }, { type: 'url', url: GIF, preview: true }],
    { [GIF]: preview(GIF, { title: host(GIF), siteName: host(GIF), image: GIF, mediaOnly: true }) },
    { media_attachments: [{ type: 'image', url: PHOTO, description: 'a cloud' }] },
  )
  ids.page = await seedPost(
    [{ type: 'text', text: 'read this ' }, { type: 'url', url: PAGE, preview: true }],
    { [PAGE]: preview(PAGE, { title: 'Old man yells at cloud', description: 'A newspaper headline', siteName: 'News', image: PHOTO }) },
  )
})

test.afterAll(async () => {
  if (author) await admin.from('posts').delete().eq('author_id', author.id)
  await deleteUser(admin, author)
})

async function openPost(page: Page, id: string) {
  await page.goto(`/social/post/${id}`)
  await dismissAnnouncements(page)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })
  return post
}

test('a GIF or attachment shows once; a page link, or a GIF beside an attachment, keeps its card', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('https://*.preview.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }))
  await page.route('https://static.klipy.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }))
  await signIn(page, author)

  const gif = await openPost(page, ids.gif)
  await expect(gif.locator('.post-text img.content-image')).toHaveCount(1)
  await expect(gif.locator(`.post-text img[src="${GIF}"]`)).toHaveCount(1)
  await expect(gif.getByText('Cloudflare!!!...')).toBeVisible()
  await expect(gif.locator('.post-link-preview')).toHaveCount(0)
  await expect(gif.locator(`img[src="${GIF}"]`)).toHaveCount(1)

  const attachment = await openPost(page, ids.attachment)
  await expect(attachment.locator('.media-gallery')).toHaveCount(1)
  await expect(attachment.locator('.post-link-preview')).toHaveCount(0)

  const beside = await openPost(page, ids.gifBesideAttachment)
  await expect(beside.locator('.media-gallery')).toHaveCount(1)
  await expect(beside.locator('.post-link-preview')).toHaveCount(1)
  await expect(beside.locator(`.post-link-preview img[src="${GIF}"]`)).toHaveCount(1)

  const article = await openPost(page, ids.page)
  const card = article.locator('.post-link-preview')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Old man yells at cloud')
})
