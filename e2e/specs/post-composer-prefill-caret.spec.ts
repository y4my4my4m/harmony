// Journeys: every path that opens the post composer with text in it leaves the caret at the
// end of that text, collapsed, as Mastodon does: after the prefilled mentions and their
// trailing space, so typing continues there. Paths: Mention on a remote and on a local
// profile page, Mention on a people card (a profile's followers), Delete and redraft, and
// Reply (inline, under the post).
//
// Each path is reached from a server channel, inside the app, as a user moves between
// chat and social. A server is then current, and the composer's editor looked its roles
// up before drawing the text it was created with; the composer had already put the caret
// at the end of a still empty editor, and the late draw restored it to the start.
//
// The caret is read as the length of the focused editor's text before the selection.

import { test, expect, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const stamp = Date.now().toString(36)
const REMOTE_DOMAIN = `prefill-${stamp}.example`
const remote = { id: randomUUID(), username: `dansup${stamp}` }
let reader: SpecUser
let local: SpecUser
let server: SeededServer
let remotePostId = ''
const ownPostIds: string[] = []

test.beforeAll(async () => {
  reader = await createUser(admin, 'pfc')
  local = await createUser(admin, 'pfl')
  server = await seedServer(admin, reader, `Prefill ${reader.username.slice(-6)}`)
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Dan',
    domain: REMOTE_DOMAIN,
    is_local: false,
    federated_id: `https://${REMOTE_DOMAIN}/users/${remote.username}`,
    inbox_url: `https://${REMOTE_DOMAIN}/users/${remote.username}/inbox`,
    remote_posts_count: 1,
    remote_followers_count: 0,
    remote_following_count: 0,
    remote_counts_fetched_at: new Date().toISOString(),
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
  const { data: post, error: postError } = await admin
    .from('posts')
    .insert({
      author_id: remote.id,
      visibility: 'public',
      is_local: false,
      ap_id: `https://${REMOTE_DOMAIN}/notes/${stamp}`,
      url: `https://${REMOTE_DOMAIN}/notes/${stamp}`,
      content: [{ type: 'text', text: 'a remote note to reply to' }],
    })
    .select('id')
    .single()
  if (postError || !post) throw new Error(`remote post: ${postError?.message}`)
  remotePostId = post.id
  const { error: followError } = await admin.from('follows').insert({ follower_id: local.id, following_id: reader.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('id', [remotePostId, ...ownPostIds].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, local)
  await deleteUser(admin, reader)
})

/** Signs in, opens the server channel, then goes to `path` inside the app. */
async function fromChannel(page: Page, path: string) {
  await signIn(page, reader)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="message-input"] .rich-text-editor')).toBeVisible({ timeout: 30000 })
  await page.evaluate((to) => {
    const root = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (to: string) => Promise<unknown> } } } } }
    return root.__vue_app__.config.globalProperties.$router.push(to)
  }, path)
}

const postDialog = (page: Page) => page.getByRole('dialog', { name: 'Create a post' })

/** Caret offset in the focused editor's text, the text's length, and whether nothing is selected. */
const caret = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement?.closest('.rich-text-editor')
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return null
    const before = document.createRange()
    before.selectNodeContents(el)
    before.setEnd(range.startContainer, range.startOffset)
    const text = (el.textContent ?? '').replace(/\u00a0/g, ' ')
    return { offset: before.toString().length, length: text.length, collapsed: range.collapsed, text }
  })

async function expectCaretAtEnd(page: Page, editor: Locator, text: string) {
  await expect(editor).toBeFocused({ timeout: 15000 })
  await expect.poll(() => caret(page), { timeout: 5000 }).toEqual({ offset: text.length, length: text.length, collapsed: true, text })
  await page.keyboard.type('hi', { delay: 20 })
  await expect.poll(async () => (await editor.textContent())?.replace(/\u00a0/g, ' ')).toBe(`${text}hi`)
}

test('Mention on a remote profile page', async ({ page }) => {
  test.setTimeout(120_000)
  await fromChannel(page, `/social/profile/@${remote.username}@${REMOTE_DOMAIN}`)
  await page.getByRole('button', { name: `Mention @${remote.username}` }).click()
  await expectCaretAtEnd(page, postDialog(page).locator('.rich-text-editor'), `@${remote.username}@${REMOTE_DOMAIN} `)
})

test('Mention on a local profile page', async ({ page }) => {
  test.setTimeout(120_000)
  await fromChannel(page, `/social/profile/${local.username}`)
  await page.getByRole('button', { name: `Mention @${local.username}` }).click()
  await expectCaretAtEnd(page, postDialog(page).locator('.rich-text-editor'), `@${local.username} `)
})

test('Mention on a people card', async ({ page }) => {
  test.setTimeout(120_000)
  await fromChannel(page, `/social/profile/${reader.username}`)
  await page.getByRole('tab', { name: /Followers/ }).click()
  const card = page.locator('.profile-card').filter({ hasText: local.username })
  await card.getByRole('button', { name: `Mention @${local.username}` }).click()
  await expectCaretAtEnd(page, postDialog(page).locator('.rich-text-editor'), `@${local.username} `)
})

test('Delete and redraft', async ({ page }) => {
  test.setTimeout(120_000)
  const { data: own, error } = await admin
    .from('posts')
    .insert({ author_id: reader.id, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'redraft this note' }] })
    .select('id')
    .single()
  if (error || !own) throw new Error(`own post: ${error?.message}`)
  ownPostIds.push(own.id)
  await fromChannel(page, `/social/post/${own.id}`)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 60000 })
  await post.getByRole('button', { name: 'More options' }).first().click()
  await page.getByRole('menuitem', { name: 'Delete and redraft' }).click()
  await page.locator('.modal-container').getByRole('button', { name: 'Delete and redraft' }).click()
  await expectCaretAtEnd(page, postDialog(page).locator('.rich-text-editor'), 'redraft this note')
})

test('Reply under a remote account’s post', async ({ page }) => {
  test.setTimeout(120_000)
  await fromChannel(page, `/social/profile/@${remote.username}@${REMOTE_DOMAIN}`)
  const post = page.locator('article').filter({ hasText: 'a remote note to reply to' }).first()
  await expect(post).toBeVisible({ timeout: 30000 })
  await post.getByRole('button', { name: /^Reply to / }).first().click()
  await expectCaretAtEnd(page, page.getByRole('textbox', { name: "What's your reply?" }), `@${remote.username}@${REMOTE_DOMAIN} `)
})
