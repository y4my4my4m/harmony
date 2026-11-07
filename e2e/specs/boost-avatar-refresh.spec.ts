// Journey: a boost and a quote show the boosted author's current avatar.
//
// A boost row stores reblog_author and a quote row reblog.author: copies of the original
// author's profile taken when the boost or quote was written (guard_post_client_write). The
// author changes their avatar afterwards; the boost header and the quoted card show the new
// one, read from the profile, while the copies in the rows keep the old one.
//
// Rows are written through each user's own client, as the app writes them. Avatar URLs are on
// a host page.route answers with a 1x1 PNG, so no image fails over to the default avatar.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, userClient, type SpecUser } from './harness'

const admin = adminClient()
let author: SpecUser
let booster: SpecUser
const marker = Date.now().toString(36)
const OLD_AVATAR = `https://avatars.e2e.test/old-${marker}.png`
const NEW_AVATAR = `https://avatars.e2e.test/new-${marker}.png`
const text = `avatar refresh ${marker}`
const ids = { original: '', boost: '', quote: '' }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

test.beforeAll(async () => {
  author = await createUser(admin, 'avra')
  booster = await createUser(admin, 'avrb')
  const { error: avatarError } = await admin.from('profiles').update({ avatar_url: OLD_AVATAR }).eq('id', author.id)
  if (avatarError) throw new Error(`old avatar: ${avatarError.message}`)

  const asAuthor = await userClient(author)
  const original = await asAuthor.from('posts')
    .insert({ author_id: author.id, visibility: 'public', is_local: true, content: [{ type: 'text', text }] })
    .select('id').single()
  if (original.error) throw new Error(`original: ${original.error.message}`)
  ids.original = original.data.id

  const asBooster = await userClient(booster)
  const boost = await asBooster.from('posts')
    .insert({ author_id: booster.id, visibility: 'public', is_local: true, content: [{ type: 'text', text }], metadata: { reblog_of: ids.original } })
    .select('id, reblog_author').single()
  if (boost.error) throw new Error(`boost: ${boost.error.message}`)
  ids.boost = boost.data.id
  const quote = await asBooster.from('posts')
    .insert({
      author_id: booster.id, visibility: 'public', is_local: true,
      content: [{ type: 'text', text: `quoting ${marker}` }],
      metadata: { reblog_of: ids.original, is_quote: true },
    })
    .select('id, reblog').single()
  if (quote.error) throw new Error(`quote: ${quote.error.message}`)
  ids.quote = quote.data.id
  if (boost.data.reblog_author?.avatar_url !== OLD_AVATAR || quote.data.reblog?.author?.avatar_url !== OLD_AVATAR) {
    throw new Error('the boost and the quote copy the author\'s avatar when written')
  }

  const { error: changeError } = await admin.from('profiles').update({ avatar_url: NEW_AVATAR }).eq('id', author.id)
  if (changeError) throw new Error(`new avatar: ${changeError.message}`)
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('id', [ids.quote, ids.boost, ids.original].filter(Boolean))
  await deleteUser(admin, booster)
  await deleteUser(admin, author)
})

test('a boost and a quote show the author\'s avatar as it is now', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('https://avatars.e2e.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))

  await signIn(page, booster)
  await page.goto('/social/local')
  await expect(page.locator('[data-testid="timeline-feed"]')).toBeVisible({ timeout: 30000 })

  const boost = page.locator(`[data-testid="post-item"][data-post-id="${ids.boost}"]`)
  const quote = page.locator(`[data-testid="post-item"][data-post-id="${ids.quote}"]`)
  await expect(boost).toBeVisible({ timeout: 60000 })
  await expect(quote).toBeVisible({ timeout: 60000 })

  // The rows still hold the copies taken before the change.
  const { data: rows } = await admin.from('posts').select('id, reblog, reblog_author').in('id', [ids.boost, ids.quote])
  expect(rows?.find((r) => r.id === ids.boost)?.reblog_author?.avatar_url).toBe(OLD_AVATAR)
  expect(rows?.find((r) => r.id === ids.quote)?.reblog?.author?.avatar_url).toBe(OLD_AVATAR)

  await expect(boost).toHaveClass(/is-reblog/)
  await expect(boost.locator('.post-header .author-info img.avatar-image')).toHaveAttribute('src', NEW_AVATAR, { timeout: 15000 })
  await expect(quote.getByTestId('quoted-post').getByTestId('quoted-author').locator('img.avatar-image'))
    .toHaveAttribute('src', NEW_AVATAR, { timeout: 15000 })

  // After a reload, from a cold profile cache.
  await page.reload()
  await expect(boost.locator('.post-header .author-info img.avatar-image')).toHaveAttribute('src', NEW_AVATAR, { timeout: 60000 })
  await expect(quote.getByTestId('quoted-post').getByTestId('quoted-author').locator('img.avatar-image'))
    .toHaveAttribute('src', NEW_AVATAR, { timeout: 15000 })
})
