// Journey: remote posts on a local user's home timeline. A remote account the user follows
// has a sensitive image post stored as the federation backend stores one now (the image in
// the content and in media_attachments), a second stored as older rows are (the image in
// the content only), and a post of 3000 characters, six times max_post_length.
//
// Both images render blurred, behind the gallery's sensitive overlay and nowhere else,
// until revealed. The long post renders to its last character.
//
// Rows are seeded through the service role; the 3000-character insert itself passes only
// because max_post_length applies to local rows.

import crypto from 'node:crypto'
import { test, expect, type Locator } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
const remote = { id: crypto.randomUUID(), username: `rem${Date.now().toString(36)}` }
const domain = 'remote.e2e.test'

// The dev server's own asset, so the image loads and its computed filter is the gallery's.
const imageUrl = new URL('/default_avatar.webp', process.env.BASE_URL || 'http://localhost:5173').href

const marker = Date.now().toString(36)
const sensitiveText = `sensitive gallery ${marker}`
const legacyText = `sensitive content parts ${marker}`
const longStart = `long start ${marker}`
const longEnd = `long end ${marker}`
const longText = `${longStart} ${'x'.repeat(3000 - longStart.length - longEnd.length - 2)} ${longEnd}`

const imagePart = { type: 'file', url: imageUrl, fileType: 'image', mimeType: 'image/webp', altText: 'avatar' }

test.beforeAll(async () => {
  reader = await createUser(admin, 'rpost')

  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote Poster',
    domain,
    is_local: false,
    federated_id: `https://${domain}/users/${remote.username}`,
    inbox_url: `https://${domain}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)

  const { error: followError } = await admin
    .from('follows')
    .insert({ follower_id: reader.id, following_id: remote.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)

  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()
  const remotePost = (slug: string, secondsAgo: number, fields: Record<string, unknown>) => ({
    author_id: remote.id,
    visibility: 'public',
    is_local: false,
    ap_id: `https://${domain}/notes/${slug}-${marker}`,
    url: `https://${domain}/notes/${slug}-${marker}`,
    created_at: at(secondsAgo),
    ...fields,
  })
  const { error: postError } = await admin.from('posts').insert([
    remotePost('gallery', 30, {
      content: [{ type: 'text', text: sensitiveText }, imagePart],
      media_attachments: [{ type: 'Document', mediaType: 'image/webp', url: imageUrl, description: 'avatar' }],
      is_sensitive: true,
    }),
    remotePost('legacy', 20, {
      content: [{ type: 'text', text: legacyText }, imagePart],
      is_sensitive: true,
    }),
    remotePost('long', 10, { content: [{ type: 'text', text: longText }] }),
  ])
  if (postError) throw new Error(`remote posts: ${postError.message}`)
})

test.afterAll(async () => {
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, reader)
})

async function blurredUntilRevealed(post: Locator) {
  const gallery = post.locator('.media-gallery')
  const image = gallery.locator('img.media-image')

  await expect(gallery).toHaveClass(/sensitive/)
  await expect(post.locator('.sensitive-overlay')).toBeVisible()
  await expect(image).toHaveCSS('filter', /blur/)
  // The content keeps its text and no second, unblurred copy of the image.
  await expect(post.locator('.post-text img:not(.inline-emoji)')).toHaveCount(0)

  await post.locator('.sensitive-overlay').click()
  await expect(gallery).not.toHaveClass(/sensitive/)
  await expect(image).toHaveCSS('filter', 'none')
  await expect(post.locator('.sensitive-hide-btn')).toBeVisible()
}

test('remote sensitive media is blurred until revealed and a long remote post renders in full', async ({ page }) => {
  test.setTimeout(180_000)

  const postWith = (text: string) => page.locator('[data-testid="post-item"]').filter({ hasText: text })

  await test.step('sign in and open the home timeline', async () => {
    await signIn(page, reader)
    await page.goto('/social/home')
    // A cold dev server compiles the timeline view on this first visit.
    await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 90000 })
    await expect(postWith(longStart)).toBeVisible({ timeout: 30000 })
  })

  await test.step('the long post renders to its last character', async () => {
    const text = postWith(longStart).locator('.post-text')
    await expect(text).toContainText(longEnd)
    expect((await text.innerText()).trim()).toBe(longText)
  })

  await test.step('media_attachments: blurred until revealed', async () => {
    await expect(postWith(sensitiveText)).toBeVisible()
    await blurredUntilRevealed(postWith(sensitiveText))
  })

  await test.step('content file parts only: blurred until revealed', async () => {
    await expect(postWith(legacyText)).toBeVisible()
    await blurredUntilRevealed(postWith(legacyText))
  })
})
