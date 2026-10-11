// Journeys: Reply prefills the composer as Mastodon does: the author, then the accounts the
// post mentions, once each, never the replier, then one space with the caret after it.
// Typing straight away and publishing stores the mentions followed by the text with a
// single separating space. The reply starts at the more restrictive of the replier's
// visibility and the post's: unlisted stays unlisted, direct stays direct.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let author: SpecUser
let third: SpecUser
let postId = ''

const mention = (u: SpecUser) => ({ type: 'mention', userId: u.id, username: u.username, domain: 'localhost', isLocal: true })

test.beforeAll(async () => {
  reader = await createUser(admin, 'rpr')
  author = await createUser(admin, 'rpa')
  third = await createUser(admin, 'rpt')
  const { data, error } = await admin
    .from('posts')
    .insert({
      author_id: author.id,
      visibility: 'public',
      is_local: true,
      content: [mention(third), { type: 'text', text: ' and ' }, mention(reader), { type: 'text', text: ' see this' }],
    })
    .select('id')
    .single()
  if (error) throw new Error(`post: ${error.message}`)
  postId = data!.id
})

async function seedPost(visibility: string): Promise<string> {
  const { data, error } = await admin
    .from('posts')
    .insert({
      author_id: author.id,
      visibility,
      is_local: true,
      content: [mention(reader), { type: 'text', text: ` ${visibility} note` }],
    })
    .select('id')
    .single()
  if (error) throw new Error(`${visibility} post: ${error.message}`)
  return data!.id
}

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [reader?.id, author?.id].filter(Boolean))
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
  await deleteUser(admin, third)
})

test('Reply prefills the author and the other mentioned accounts, then one space', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${postId}`)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })

  await post.getByRole('button', { name: /^Reply to / }).first().click()
  const editor = page.locator('[data-testid="compose-post"] .rich-text-editor').last()
  await expect(editor).toBeFocused({ timeout: 15000 })
  // Author first, the post's other mention next, the replier left out.
  await expect
    .poll(async () => (await editor.innerText()).replace(/ /g, ' '))
    .toBe(`@${author.username} @${third.username} `)

  await page.keyboard.type('thanks', { delay: 20 })
  const written = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/posts') && r.request().method() === 'POST',
    { timeout: 30000 },
  )
  await page.locator('[data-testid="compose-submit"]').last().click()
  expect((await written).ok()).toBe(true)

  const { data, error } = await admin
    .from('posts')
    .select('content, in_reply_to')
    .eq('author_id', reader.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  expect(error).toBeNull()
  expect(data!.in_reply_to).toBe(postId)
  const parts = data!.content as Array<Record<string, any>>
  expect(parts.filter((p) => p.type === 'mention').map((p) => p.username)).toEqual([author.username, third.username])
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('|')
  expect(text).toBe(' | thanks')
})

for (const [visibility, label] of [['unlisted', 'Unlisted'], ['direct', 'Mentioned people only']] as const) {
  test(`a reply to a ${visibility} post starts ${visibility}`, async ({ page }) => {
    test.setTimeout(180_000)
    const parentId = await seedPost(visibility)
    await signIn(page, reader)
    await page.goto(`/social/post/${parentId}`)
    const post = page.locator('article[aria-current="true"]')
    await expect(post).toBeVisible({ timeout: 90_000 })

    await post.getByRole('button', { name: /^Reply to / }).first().click()
    await expect(page.locator('[data-testid="compose-post"] .rich-text-editor').last()).toBeFocused({ timeout: 15000 })
    await expect(page.locator('[data-testid="compose-visibility"]').last()).toHaveAccessibleName(`Visibility: ${label}`)

    await page.keyboard.type('noted', { delay: 20 })
    const written = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/posts') && r.request().method() === 'POST',
      { timeout: 30000 },
    )
    await page.locator('[data-testid="compose-submit"]').last().click()
    expect((await written).ok()).toBe(true)

    const { data, error } = await admin
      .from('posts')
      .select('visibility')
      .eq('author_id', reader.id)
      .eq('in_reply_to', parentId)
      .single()
    expect(error).toBeNull()
    expect(data!.visibility).toBe(visibility)
  })
}
