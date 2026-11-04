// Journeys: a post's page counts every reply below it that the reader sees, nested ones
// included, as its header counts the conversation's posts; cards count direct replies, as
// Mastodon does.
//
//   chain     a remote top post answered by a local account three times, each reply to the
//             one before (the shape of a back-and-forth): header "4 posts", "3 replies";
//             the top post's card "1"
//   siblings  a top post with two direct replies and a reply to the first: "3 replies",
//             the card "2"

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let replier: SpecUser
const marker = Date.now().toString(36)
const jons = { id: crypto.randomUUID(), username: `jons${marker}`, domain: 'mony.e2e.test' }
const ids: Record<string, string> = {}
const text = {
  chainRoot: `how do I join a server ${marker}`,
  chain1: `put this in join by URL ${marker}`,
  chain2: `or use the invite ${marker}`,
  chain3: `i meant to say there is no discovery yet ${marker}`,
  siblingRoot: `sibling root ${marker}`,
  sibling1: `first sibling ${marker}`,
  sibling2: `second sibling ${marker}`,
  nested: `under the first sibling ${marker}`,
}

async function insertPost(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('posts').insert(row).select('id').single()
  if (error || !data) throw new Error(`posts: ${error?.message}`)
  return data.id as string
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'prcr')
  replier = await createUser(admin, 'prcp')
  const { error } = await admin.from('profiles').insert({
    id: jons.id, username: jons.username, display_name: 'JonsJava', domain: jons.domain, is_local: false,
    federated_id: `https://${jons.domain}/users/${jons.username}`, inbox_url: `https://${jons.domain}/users/${jons.username}/inbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
  // Home holds only the reader's follows: no other spec's posts push these off its first page.
  const { error: followError } = await admin.from('follows').insert([
    { follower_id: reader.id, following_id: jons.id, status: 'accepted' },
    { follower_id: reader.id, following_id: replier.id, status: 'accepted' },
  ])
  if (followError) throw new Error(`follows: ${followError.message}`)

  let minute = 0
  const at = () => new Date(Date.now() - 60 * 60_000 + minute++ * 60_000).toISOString()
  const local = (body: string, parent: string) => insertPost({
    author_id: replier.id, visibility: 'public', is_local: true, in_reply_to: parent,
    content: [{ type: 'text', text: body }], created_at: at(),
  })
  ids.chainRoot = await insertPost({
    author_id: jons.id, visibility: 'public', is_local: false,
    ap_id: `https://${jons.domain}/users/${jons.username}/statuses/1`,
    content: [{ type: 'text', text: text.chainRoot }], created_at: at(),
  })
  ids.chain1 = await local(text.chain1, ids.chainRoot)
  ids.chain2 = await local(text.chain2, ids.chain1)
  ids.chain3 = await local(text.chain3, ids.chain2)

  ids.siblingRoot = await insertPost({
    author_id: reader.id, visibility: 'public', is_local: true,
    content: [{ type: 'text', text: text.siblingRoot }], created_at: at(),
  })
  ids.sibling1 = await local(text.sibling1, ids.siblingRoot)
  ids.sibling2 = await local(text.sibling2, ids.siblingRoot)
  ids.nested = await local(text.nested, ids.sibling1)
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [replier?.id, reader?.id, jons.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', jons.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, replier)
})

const opened = (page: Page) => page.locator('.post-view article[aria-current="true"]')
const repliesStat = (page: Page) => opened(page).locator('.detail-stat').filter({ hasText: /repl(y|ies)/ })
// The card's own text: a reply's card also holds its parent's text in its preview.
const card = (page: Page, body: string) =>
  page.locator('article[data-testid="post-item"]').filter({ has: page.locator('.post-text', { hasText: body }) })

test('a back-and-forth under a post counts every reply on its page', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${ids.chainRoot}`)
  await expect(opened(page)).toContainText(text.chainRoot, { timeout: 90_000 })
  await expect(page.locator('.post-view')).toContainText('4 posts · 2 participants')
  await expect(repliesStat(page)).toHaveText('3 replies')

  // Each reply in the chain counts its own direct reply.
  const counts = page.locator('.thread-post:not(.is-main-post)')
  await expect(counts.filter({ hasText: text.chain1 }).getByTestId('post-reply-count')).toHaveText('1')
  await expect(counts.filter({ hasText: text.chain2 }).getByTestId('post-reply-count')).toHaveText('1')
  await expect(counts.filter({ hasText: text.chain3 }).getByTestId('post-reply-count')).toHaveCount(0)
})

test('sibling and nested replies both count on the page; the card counts direct replies', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${ids.siblingRoot}`)
  await expect(opened(page)).toContainText(text.siblingRoot, { timeout: 90_000 })
  await expect(repliesStat(page)).toHaveText('3 replies')

  await page.goto('/social/home')
  await expect(card(page, text.chainRoot).getByTestId('post-reply-count')).toHaveText('1', { timeout: 90_000 })
  await expect(card(page, text.siblingRoot).getByTestId('post-reply-count')).toHaveText('2')
})
