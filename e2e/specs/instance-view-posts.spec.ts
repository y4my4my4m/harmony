// Journey: "View All Posts" in an instance's details, and "View posts" on its card, open this
// app's list of that instance's public posts, not a page on the instance itself. The list
// holds the instance's posts and no others.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let viewer: SpecUser
const tag = crypto.randomUUID().slice(0, 8)
const PEER = `posts-${tag}.e2e.test`
const ELSEWHERE = `elsewhere-${tag}.e2e.test`
const peerAuthor = { id: crypto.randomUUID(), username: `peer${tag}` }
const otherAuthor = { id: crypto.randomUUID(), username: `else${tag}` }
const PEER_TEXT = `Hello from the peer ${tag}`
const OTHER_TEXT = `Hello from elsewhere ${tag}`

test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  viewer = await createUser(admin, 'ivp')
  const now = new Date().toISOString()
  const instances = await admin.from('federated_instances').insert([
    { domain: PEER, software: 'harmony', last_seen_at: now, metadata: {} },
    { domain: ELSEWHERE, software: 'mastodon', last_seen_at: now, metadata: {} },
  ])
  if (instances.error) throw new Error(`instances: ${instances.error.message}`)
  for (const [author, domain] of [[peerAuthor, PEER], [otherAuthor, ELSEWHERE]] as const) {
    const { error } = await admin.from('profiles').insert({
      id: author.id,
      username: author.username,
      display_name: author.username,
      domain,
      is_local: false,
      federated_id: `https://${domain}/users/${author.username}`,
      inbox_url: `https://${domain}/users/${author.username}/inbox`,
    })
    if (error) throw new Error(`profile: ${error.message}`)
  }
  const posts = await admin.from('posts').insert([
    { author_id: peerAuthor.id, content: [{ type: 'text', text: PEER_TEXT }], visibility: 'public', is_local: false, ap_id: `https://${PEER}/notes/${tag}` },
    { author_id: otherAuthor.id, content: [{ type: 'text', text: OTHER_TEXT }], visibility: 'public', is_local: false, ap_id: `https://${ELSEWHERE}/notes/${tag}` },
  ])
  if (posts.error) throw new Error(`posts: ${posts.error.message}`)
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [peerAuthor.id, otherAuthor.id])
  await admin.from('profiles').delete().in('id', [peerAuthor.id, otherAuthor.id])
  await admin.from('federated_instances').delete().in('domain', [PEER, ELSEWHERE])
  await deleteUser(admin, viewer)
})

async function stubProbe(page: Page) {
  await page.route('**/api/federation/instances/probe**', (route) => route.fulfill({ status: 404, json: { error: 'Could not discover instance' } }))
}

async function expectPeerPosts(page: Page) {
  await expect(page).toHaveURL(new RegExp(`/social/instances/${PEER.replace(/\./g, '\\.')}$`), { timeout: 30000 })
  await expect(page.getByRole('heading', { name: PEER })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('[data-testid="post-item"]').filter({ hasText: PEER_TEXT })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(OTHER_TEXT)).toHaveCount(0)
  await expect(page.locator('[data-testid="not-found"]')).toHaveCount(0)
}

test('View All Posts in the instance details opens the instance\'s posts', async ({ page, context }) => {
  test.setTimeout(120_000)
  await stubProbe(page)
  await signIn(page, viewer)
  await page.goto('/social/instances')

  const card = page.locator(`.instance-card[aria-label="${PEER}"]`)
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.click()
  const modal = page.locator('.instance-detail-modal')
  await expect(modal.locator('.instance-domain')).toHaveText(PEER, { timeout: 30000 })
  const pagesBefore = context.pages().length
  await modal.getByRole('button', { name: 'View All Posts' }).click()

  await expectPeerPosts(page)
  await expect(modal).toBeHidden()
  expect(context.pages()).toHaveLength(pagesBefore)
})

test('View posts on the instance card opens the same list', async ({ page }) => {
  test.setTimeout(120_000)
  await stubProbe(page)
  await signIn(page, viewer)
  await page.goto('/social/instances')

  const card = page.locator(`.instance-card[aria-label="${PEER}"]`)
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.getByRole('button', { name: 'View posts' }).click()
  await expectPeerPosts(page)
})
