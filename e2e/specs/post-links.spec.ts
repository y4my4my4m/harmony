// Journey: a post's menu says which link it copies. "Copy link" is the post on this instance
// and names this instance's host; a post from another server adds "Copy original link" and
// "Open original", which name that server's host. A local post has no original.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
const DOMAIN = 'links.example'
let viewer: SpecUser
let localPostId = ''
let remotePostId = ''
const remote = { id: randomUUID(), username: `lnk${Date.now().toString(36)}` }
const remotePage = `https://${DOMAIN}/@${remote.username}/42`

test.beforeAll(async () => {
  viewer = await createUser(admin, 'plk')
  const actor = `https://${DOMAIN}/users/${remote.username}`
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Links',
    domain: DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
  const remotePost = await admin.from('posts').insert({
    author_id: remote.id,
    ap_id: `${actor}/statuses/42`,
    url: remotePage,
    is_local: false,
    visibility: 'public',
    content: [{ type: 'text', text: 'a post from elsewhere' }],
  }).select('id').single()
  if (remotePost.error) throw new Error(`remote post: ${remotePost.error.message}`)
  remotePostId = remotePost.data!.id
  const localPost = await admin.from('posts').insert({
    author_id: viewer.id,
    is_local: true,
    visibility: 'public',
    content: [{ type: 'text', text: 'a post from here' }],
  }).select('id').single()
  if (localPost.error) throw new Error(`local post: ${localPost.error.message}`)
  localPostId = localPost.data!.id
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [remote.id, viewer?.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, viewer)
})

async function openMenu(page: Page, postId: string) {
  await page.goto(`/social/post/${postId}`)
  await dismissAnnouncements(page)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[]; __opened: string[] }
    w.__copied = []
    w.__opened = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { w.__copied.push(text) } })
    window.open = ((url: string) => { w.__opened.push(String(url)); return null }) as typeof window.open
  })
  await post.getByTestId('post-menu-btn').first().click()
  return page.getByTestId('post-menu')
}

const recorded = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __copied: string[]; __opened: string[] }
  return { copied: w.__copied, opened: w.__opened }
})

test('a remote post offers its link here and its original, each naming its host', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, viewer)
  const menu = await openMenu(page, remotePostId)
  const here = new URL(page.url()).host

  const copyHere = menu.getByTestId('post-copy-link')
  await expect(copyHere).toContainText('Copy link')
  await expect(copyHere).toContainText(here)
  await copyHere.click()
  expect((await recorded(page)).copied).toEqual([`${new URL(page.url()).origin}/posts/${remotePostId}`])

  const menuAgain = await openMenu(page, remotePostId)
  const copyOriginal = menuAgain.getByTestId('post-copy-original-link')
  await expect(copyOriginal).toContainText('Copy original link')
  await expect(copyOriginal).toContainText(DOMAIN)
  await copyOriginal.click()
  expect((await recorded(page)).copied).toEqual([remotePage])

  const menuThird = await openMenu(page, remotePostId)
  const openOriginal = menuThird.getByTestId('post-open-original')
  await expect(openOriginal).toContainText(DOMAIN)
  await openOriginal.click()
  expect((await recorded(page)).opened).toEqual([remotePage])
})

test('a local post offers its link here only', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, viewer)
  const menu = await openMenu(page, localPostId)
  await expect(menu.getByTestId('post-copy-link')).toContainText(new URL(page.url()).host)
  await expect(menu.getByTestId('post-copy-original-link')).toHaveCount(0)
  await expect(menu.getByTestId('post-open-original')).toHaveCount(0)
})
