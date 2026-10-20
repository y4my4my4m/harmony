// Journey: /authorize_interaction, the page the WebFinger subscribe template of every local
// account names (http://ostatus.org/schema/1.0/subscribe). A remote instance sends its user
// here with ?uri= naming an account or a post.
//
//   - signed out, the page asks for a sign-in and returns to the same uri after it;
//   - a remote handle shows the account and follows it: a request until the remote side
//     accepts;
//   - a local handle follows at once;
//   - an actor URL resolves through the federation backend's /lookup-user;
//   - a post URL shows the post and opens it;
//   - something that is no handle or link, and a handle nobody answers for, say so.
//
// The remote account and its post are stored rows, as federation stores them; the backend
// (e2e/specs/backend.ts) answers /lookup-user and /resolve-post.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, instanceDomain, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let reader: SpecUser
let target: SpecUser
let backend: Backend
const marker = Date.now().toString(36)
const remoteDomain = 'remote.e2e.test'
const remote = { id: crypto.randomUUID(), username: `rauth${marker}` }
const remoteActor = `https://${remoteDomain}/users/${remote.username}`
const remotePost = { id: crypto.randomUUID(), apId: `https://${remoteDomain}/notes/auth-${marker}`, text: `remote post to open ${marker}` }

test.beforeAll(async () => {
  // Starts the federation backend under tsx: past 30 s on a loaded CI runner.
  test.setTimeout(120_000)
  reader = await createUser(admin, 'authz')
  target = await createUser(admin, 'autht')
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote Account',
    bio: 'lives elsewhere',
    domain: remoteDomain,
    is_local: false,
    federated_id: remoteActor,
    inbox_url: `${remoteActor}/inbox`,
    // Fresh counts: /lookup-user reads none from the unreachable remote.
    remote_counts_fetched_at: new Date().toISOString(),
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: postError } = await admin.from('posts').insert({
    id: remotePost.id,
    author_id: remote.id,
    visibility: 'public',
    is_local: false,
    ap_id: remotePost.apId,
    url: remotePost.apId,
    content: [{ type: 'text', text: remotePost.text }],
  })
  if (postError) throw new Error(`remote post: ${postError.message}`)
  backend = await startBackend()
})

// Heartbeats and push reads still in flight when a test ends must not fail it.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('profiles').delete().eq('id', remote.id)
  for (const user of [reader, target]) await deleteUser(admin, user)
})

const authorize = (uri: string) => `/authorize_interaction?uri=${encodeURIComponent(uri)}`

async function open(page: Page, uri: string) {
  await page.goto(authorize(uri))
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="authorize-interaction"]')).toBeVisible({ timeout: 60000 })
}

async function followRow(followingId: string) {
  const { data } = await admin.from('follows').select('status').eq('follower_id', reader.id).eq('following_id', followingId).maybeSingle()
  return data
}

test('signed out, the page returns to its uri after sign-in', async ({ page }) => {
  test.setTimeout(150_000)
  await backend.route(page)
  await page.goto(authorize(`@${remote.username}@${remoteDomain}`))
  await expect(page).toHaveURL(/\/login/, { timeout: 60000 })
  await page.locator('[data-testid="auth-email"]').fill(reader.email)
  await page.locator('[data-testid="auth-password"]').fill(reader.password)
  await page.locator('[data-testid="auth-submit"]').click()
  await page.waitForURL(/\/authorize_interaction\?uri=/, { timeout: 30000 })
  await expect(page.locator('[data-testid="authorize-handle"]')).toHaveText(`@${remote.username}@${remoteDomain}`, { timeout: 30000 })
})

test('a remote handle is followed as a request, a local one at once', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, reader)

  await test.step('the remote account is shown with Follow and its profile', async () => {
    await open(page, `acct:${remote.username}@${remoteDomain}`)
    const actor = page.locator('[data-testid="authorize-actor"]')
    await expect(actor).toBeVisible({ timeout: 30000 })
    await expect(actor.locator('[data-testid="authorize-handle"]')).toHaveText(`@${remote.username}@${remoteDomain}`)
    await expect(actor).toContainText('lives elsewhere')
    await expect(actor.locator('[data-testid="authorize-open-profile"]')).toHaveAttribute('href', `/social/profile/${remote.username}@${remoteDomain}`)
    await expect(actor.locator('[data-testid="authorize-follow"]')).toHaveText('Follow')
  })

  await test.step('Follow sends a request', async () => {
    await page.locator('[data-testid="authorize-follow"]').click()
    await expect(page.locator('[data-testid="authorize-follow"]')).toHaveText('Requested', { timeout: 30000 })
    await expect.poll(async () => (await followRow(remote.id))?.status, { timeout: 15000 }).toBe('pending')
  })

  await test.step('the request survives a reload', async () => {
    await page.reload()
    await expect(page.locator('[data-testid="authorize-follow"]')).toHaveText('Requested', { timeout: 30000 })
  })

  await test.step('a local account is followed at once', async () => {
    const domain = await instanceDomain(admin)
    await open(page, `@${target.username}@${domain}`)
    await expect(page.locator('[data-testid="authorize-handle"]')).toHaveText(`@${target.username}`, { timeout: 30000 })
    await page.locator('[data-testid="authorize-follow"]').click()
    await expect(page.locator('[data-testid="authorize-follow"]')).toHaveText('Following', { timeout: 30000 })
    await expect.poll(async () => (await followRow(target.id))?.status, { timeout: 15000 }).toBe('accepted')
  })
})

test('an actor URL and a post URL resolve; anything else says so', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, reader)

  await test.step('an actor URL names its account through /lookup-user', async () => {
    const lookups: string[] = []
    page.on('request', (r) => { if (r.url().includes('/lookup-user')) lookups.push(r.postData() ?? '') })
    await open(page, remoteActor)
    await expect(page.locator('[data-testid="authorize-handle"]')).toHaveText(`@${remote.username}@${remoteDomain}`, { timeout: 60000 })
    expect(lookups.some((body) => body.includes(remoteActor))).toBe(true)
  })

  await test.step('a post URL shows the post and opens it', async () => {
    await open(page, remotePost.apId)
    const card = page.locator('[data-testid="authorize-post"]')
    await expect(card).toBeVisible({ timeout: 30000 })
    await expect(card.locator('[data-testid="authorize-post-text"]')).toHaveText(remotePost.text)
    await card.locator('[data-testid="authorize-open-post"]').click()
    await expect(page).toHaveURL(new RegExp(`/social/post/${remotePost.id}`), { timeout: 30000 })
    await expect(page.locator('[data-testid="post-item"]').filter({ hasText: remotePost.text }).first()).toBeVisible({ timeout: 60000 })
  })

  await test.step('no handle or link, and a handle nobody answers for', async () => {
    await open(page, 'not a handle')
    await expect(page.locator('[data-testid="authorize-error"]')).toContainText('This is not a handle or a link.')
    await open(page, `nobody${marker}@${remoteDomain}`)
    await expect(page.locator('[data-testid="authorize-error"]')).toContainText('Nothing could be found at this address.', { timeout: 60000 })
  })
})
