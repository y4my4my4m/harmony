// Journeys: a reply in a feed previews the post it answers, above its own text: the parent's
// avatar, name and the start of its text in two lines at most, one link to the parent's page
// with the reply highlighted. A parent with a content warning shows the warning, a parent
// without text names its attachment. A deleted parent, one the reader may not see and one not
// stored here each say so on one line; the last links to its origin, and one the federation
// backend can fetch is previewed once fetched.
//
// The home feed's rows embed the parent (get_home_timeline_page reply_parent): no card reads
// its parent on its own. The local feed's PostgREST embed is quote-reply-links.spec.ts's.
//
// Rows are seeded through the service role, as the federation backend stores them: remote
// accounts on .e2e.test domains, a reply whose parent never arrived keeps in_reply_to NULL and
// the parent's id in metadata.in_reply_to_ap_url.

import crypto from 'node:crypto'
import { test, expect, type Page, type Request } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
let reader: SpecUser
let friend: SpecUser
// Reads the feed under each skin; its appearance changes do not reach the other tests.
let skinReader: SpecUser
let backend: Backend
const marker = Date.now().toString(36)
const toonie = { id: crypto.randomUUID(), username: `toonie${marker}`, domain: 'meow.e2e.test', name: 'Toonie' }
const moshboy = { id: crypto.randomUUID(), username: `moshboy${marker}`, domain: 'mastodon.e2e.test', name: 'Moshboy' }
const shy = { id: crypto.randomUUID(), username: `shy${marker}`, domain: 'quiet.e2e.test', name: 'Shy Person' }
const goneUrl = `https://gone.e2e.test/users/someone/statuses/${marker}`
const lateUrl = `https://${toonie.domain}/users/${toonie.username}/statuses/late-${marker}`
const LONG = `${'a long parent that keeps going '.repeat(20)}${marker}`

const ids: Record<string, string> = {}
const text = {
  parent: `is this the right place for the meetup ${marker}`,
  agreed: `agreed ${marker}`,
  long: `answer to the long one ${marker}`,
  media: `answer to the photo ${marker}`,
  cw: `answer to the warning ${marker}`,
  deleted: `answer to the deleted one ${marker}`,
  hidden: `answer to the quiet one ${marker}`,
  gone: `answer to the vanished one ${marker}`,
  late: `answer to the late one ${marker}`,
  lateParent: `the late parent ${marker}`,
}

test.use({ serviceWorkers: 'block' })

async function insertPost(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('posts').insert(row).select('id').single()
  if (error || !data) throw new Error(`posts: ${error?.message}`)
  return data.id as string
}

const remoteProfile = (p: typeof toonie) => ({
  id: p.id,
  username: p.username,
  display_name: p.name,
  domain: p.domain,
  is_local: false,
  federated_id: `https://${p.domain}/users/${p.username}`,
  inbox_url: `https://${p.domain}/users/${p.username}/inbox`,
})

test.beforeAll(async () => {
  reader = await createUser(admin, 'rcxr')
  friend = await createUser(admin, 'rcxf')
  skinReader = await createUser(admin, 'rcxs')
  const { error: profileError } = await admin.from('profiles').insert([remoteProfile(toonie), remoteProfile(moshboy), remoteProfile(shy)])
  if (profileError) throw new Error(`remote profiles: ${profileError.message}`)
  const { error: followError } = await admin.from('follows').insert([
    { follower_id: reader.id, following_id: friend.id, status: 'accepted' },
    { follower_id: reader.id, following_id: moshboy.id, status: 'accepted' },
    { follower_id: skinReader.id, following_id: friend.id, status: 'accepted' },
    { follower_id: skinReader.id, following_id: moshboy.id, status: 'accepted' },
  ])
  if (followError) throw new Error(`follows: ${followError.message}`)

  let minute = 0
  const at = () => new Date(Date.now() - 60 * 60_000 + minute++ * 60_000).toISOString()
  const remote = (author: typeof toonie, body: string, extra: Record<string, unknown> = {}) => insertPost({
    author_id: author.id, visibility: 'public', is_local: false,
    ap_id: `https://${author.domain}/users/${author.username}/statuses/${crypto.randomUUID()}`,
    content: [{ type: 'text', text: body }], created_at: at(), ...extra,
  })
  const reply = (body: string, parent: string | null, extra: Record<string, unknown> = {}) => remote(moshboy, body, {
    in_reply_to: parent,
    content: [{ type: 'mention', username: toonie.username, domain: toonie.domain, isLocal: false }, { type: 'text', text: ` ${body}` }],
    ...extra,
  })

  ids.parent = await remote(toonie, '', {
    content: [{ type: 'mention', username: moshboy.username, domain: moshboy.domain, isLocal: false }, { type: 'text', text: ` ${text.parent}` }],
  })
  ids.long = await remote(toonie, LONG)
  ids.media = await remote(toonie, '', {
    content: [{ type: 'text', text: ' ' }],
    media_attachments: [{ id: 'm1', type: 'image', url: '/default_avatar.webp', description: 'a photo' }],
  })
  ids.cw = await remote(toonie, 'the butler did it', { content_warning: 'film ending' })
  ids.deleted = await remote(toonie, 'secret deleted words', { is_deleted: true, deleted_at: at() })
  ids.hidden = await remote(shy, 'followers only words', { visibility: 'followers' })

  ids.agreed = await reply(text.agreed, ids.parent)
  ids.longReply = await insertPost({
    author_id: friend.id, visibility: 'public', is_local: true, in_reply_to: ids.long,
    content: [{ type: 'text', text: text.long }], created_at: at(),
  })
  ids.mediaReply = await reply(text.media, ids.media)
  ids.cwReply = await reply(text.cw, ids.cw)
  ids.deletedReply = await reply(text.deleted, ids.deleted)
  ids.hiddenReply = await reply(text.hidden, ids.hidden)
  ids.goneReply = await reply(text.gone, null, { metadata: { in_reply_to_ap_url: goneUrl } })
  ids.lateReply = await reply(text.late, null, { metadata: { in_reply_to_ap_url: lateUrl } })
  // Stored after its reply and not linked to it: the backend's fetch finds it and links the reply.
  ids.lateParent = await remote(toonie, text.lateParent, { ap_id: lateUrl, url: lateUrl })

  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await admin.from('posts').delete().in('author_id', [moshboy.id, friend?.id].filter(Boolean))
  await admin.from('posts').delete().in('author_id', [toonie.id, shy.id])
  await admin.from('profiles').delete().in('id', [toonie.id, moshboy.id, shy.id])
  await deleteUser(admin, reader)
  await deleteUser(admin, friend)
  await deleteUser(admin, skinReader)
})

const card = (page: Page, body: string) => page.locator('article[data-testid="post-item"]').filter({ hasText: body })
const preview = (page: Page, body: string) => card(page, body).getByTestId('post-reply-context')

/** Requests a card makes for its own parent before 1.9.3: one posts read by the parent's id. */
const perCardRead = (r: Request) => r.url().includes('/rest/v1/posts?') && r.url().includes('id=eq.')
  && decodeURIComponent(r.url()).includes('select=id,content,created_at,visibility')
const batchRead = (r: Request) => r.url().includes('/rest/v1/posts?') && decodeURIComponent(r.url()).includes('reply_parent:in_reply_to')

test('the home feed previews each reply\'s parent from its own rows', async ({ page }) => {
  test.setTimeout(240_000)
  await backend.route(page)
  await signIn(page, reader)
  const requests: Request[] = []
  page.on('request', (r) => requests.push(r))
  const resolves: string[] = []
  page.on('request', (r) => { if (r.url().includes('/resolve-reply-parents')) resolves.push(r.postData() ?? '') })

  await page.goto('/social/home')
  const agreed = preview(page, text.agreed)
  await expect(agreed).toBeVisible({ timeout: 90_000 })
  await expect(agreed).toHaveAttribute('data-state', 'post')
  await expect(agreed).toContainText(toonie.name)
  // The parent's leading mention is left out of its text.
  await expect(agreed.locator('.reply-context-snippet')).toHaveText(text.parent)
  await expect(agreed).toHaveAttribute('title', `Replying to @${toonie.username}@${toonie.domain}`)
  await expect(agreed).toHaveAccessibleName(`Replying to ${toonie.name} ${text.parent}`)

  await expect(preview(page, text.long).locator('.reply-context-snippet')).toContainText('a long parent that keeps going')
  await expect(preview(page, text.media)).toContainText('Image')
  const cw = preview(page, text.cw)
  await expect(cw.locator('.reply-context-snippet')).toHaveText('CW: film ending')
  await expect(cw).not.toContainText('butler')

  const deleted = preview(page, text.deleted)
  await expect(deleted).toHaveAttribute('data-state', 'deleted')
  await expect(deleted).toHaveText('Replying to a deleted post')
  await expect(card(page, text.deleted)).not.toContainText('secret deleted words')

  const hidden = preview(page, text.hidden)
  await expect(hidden).toHaveAttribute('data-state', 'hidden')
  await expect(hidden).toHaveText("Replying to a post you can't see")
  await expect(card(page, text.hidden)).not.toContainText(shy.name)

  const gone = preview(page, text.gone)
  await expect(gone).toHaveAttribute('data-state', 'remote')
  await expect(gone).toHaveText('Replying to a post on gone.e2e.test')
  await expect(gone).toHaveAttribute('href', goneUrl)

  // Fetched through the backend, linked, then read: the late parent is previewed.
  const late = preview(page, text.late)
  await expect(late).toHaveAttribute('data-state', 'post', { timeout: 30_000 })
  await expect(late.locator('.reply-context-snippet')).toHaveText(text.lateParent)
  const { data: linked } = await admin.from('posts').select('in_reply_to').eq('id', ids.lateReply).single()
  expect(linked?.in_reply_to).toBe(ids.lateParent)

  expect(requests.filter(perCardRead)).toHaveLength(0)
  // One read: the reply the backend linked. Every other parent came with its row.
  expect(requests.filter(batchRead).map((r) => decodeURIComponent(r.url()).match(/id=in\.\(([^)]*)\)/)?.[1])).toEqual([ids.lateReply])
  expect(resolves).toHaveLength(1)
  expect(JSON.parse(resolves[0]).post_ids.sort()).toEqual([ids.goneReply, ids.lateReply].sort())
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a preview opens the parent with the reply highlighted', async ({ page }) => {
  test.setTimeout(180_000)
  await backend.route(page)
  await signIn(page, reader)
  await page.goto('/social/home')
  const agreed = preview(page, text.agreed)
  await expect(agreed).toBeVisible({ timeout: 90_000 })
  await agreed.click()
  await expect(page).toHaveURL(new RegExp(`/@[^/]+/${ids.parent}\\?highlight=${ids.agreed}$`))
  await expect(page.locator('.post-view article[aria-current="true"]')).toContainText(text.parent, { timeout: 30_000 })
  await expect(page.locator(`.thread-post.highlighted-post[data-post-id="${ids.agreed}"]`)).toContainText(text.agreed)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('on a phone a preview takes two lines at most and stays inside the card', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await backend.route(page)
  await signIn(page, reader)
  await page.goto('/social/home')
  const long = preview(page, text.long)
  await expect(long).toBeVisible({ timeout: 90_000 })

  for (const body of [text.long, text.agreed, text.hidden]) {
    const layout = await card(page, body).evaluate((article) => {
      const box = article.querySelector('[data-testid="post-reply-context"]') as HTMLElement
      const textBox = box.querySelector('.reply-context-text') as HTMLElement
      const lineHeight = parseFloat(getComputedStyle(textBox).lineHeight)
      const body = article.querySelector('.post-content') as HTMLElement
      return {
        lines: Math.round(textBox.getBoundingClientRect().height / lineHeight),
        clipped: textBox.scrollHeight > textBox.clientHeight + 1,
        right: box.getBoundingClientRect().right,
        bodyRight: body.getBoundingClientRect().right,
        articleScroll: article.scrollWidth - article.clientWidth,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(layout.lines, body).toBeLessThanOrEqual(body === text.hidden ? 1 : 2)
    expect(layout.right, body).toBeLessThanOrEqual(layout.bodyRight + 0.5)
    expect(layout.articleScroll, body).toBeLessThanOrEqual(0)
    expect(layout.pageScroll, body).toBeLessThanOrEqual(0)
    if (body === text.long) expect(layout.clipped).toBe(true)
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.describe('under each skin', () => {
  test.describe.configure({ mode: 'serial' })
  const looks = [
    { skin: null, theme: 'dark', highContrast: false },
    { skin: null, theme: 'light', highContrast: false },
    { skin: 'paper', theme: 'light', highContrast: false },
    { skin: 'skyglass', theme: 'dark', highContrast: false },
    { skin: null, theme: 'dark', highContrast: true },
  ] as const

  for (const look of looks) {
    const label = `${look.skin ?? 'no skin'} ${look.theme}${look.highContrast ? ' high contrast' : ''}`
    test(`previews read in ${label}`, async ({ page }) => {
      test.setTimeout(180_000)
      const { error } = await admin.from('profiles')
        .update({ appearance_settings: { theme: look.theme, activeSkinId: look.skin, highContrast: look.highContrast } })
        .eq('id', skinReader.id)
      if (error) throw new Error(`appearance: ${error.message}`)
      await backend.route(page)
      await signIn(page, skinReader)
      await page.goto('/social/home')
      await expect(preview(page, text.agreed)).toBeVisible({ timeout: 90_000 })
      await expect(preview(page, text.hidden)).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme-type', look.theme, { timeout: 15_000 })
      if (look.skin) await expect(page.locator('html')).toHaveAttribute('data-skin', look.skin, { timeout: 15_000 })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(600)
      for (const body of [text.agreed, text.hidden, text.gone]) {
        const id = await card(page, body).getAttribute('data-post-id')
        await expectNoAxeViolations(page, {
          include: `article[data-post-id="${id}"] [data-testid="post-reply-context"]`,
          rules: ['color-contrast'],
          label: `${label} ${body}`,
        })
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    })
  }
})
