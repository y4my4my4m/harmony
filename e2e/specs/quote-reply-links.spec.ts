// Journeys: where a quote post and a reply lead.
//
// The quoted card of a quote post opens the quoted post; its author's name opens their
// profile, a hashtag inside it opens the hashtag, and the keyboard reaches the quoted post
// through the card's time link. A reply in a feed says whom it answers on one line, however
// long the handle, and the line opens the parent post.
//
// Rows are seeded through the service role, as the federation backend stores them: a remote
// account quotes a remote post (Mastodon 4.4+ quotes), and a local reply answers a remote
// account on a long domain.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let author: SpecUser
const marker = Date.now().toString(36)
const quoter = { id: crypto.randomUUID(), username: `dansup${marker}`, domain: 'mastodon.e2e.test' }
const quoted = { id: crypto.randomUUID(), username: `apps${marker}`, domain: 'stats.e2e.test' }
const parentAuthor = { id: crypto.randomUUID(), username: `someone${marker}`, domain: 'a.very.long.instance.name.example.e2e.test' }
const tag = `fediapps${marker}`
const ids = { quoted: '', quote: '', parent: '', reply: '' }

async function insertPost(row: Record<string, unknown>): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await admin.from('posts').insert(row).select('id').single()
    if (!error && data) return data.id as string
    if (attempt < 4 && error?.message.includes('timeline_entries_user_id_fkey')) continue
    throw new Error(`posts: ${error?.message}`)
  }
}

const remoteProfile = (p: { id: string; username: string; domain: string }, displayName: string) => ({
  id: p.id,
  username: p.username,
  display_name: displayName,
  domain: p.domain,
  is_local: false,
  federated_id: `https://${p.domain}/users/${p.username}`,
  inbox_url: `https://${p.domain}/users/${p.username}/inbox`,
})

test.beforeAll(async () => {
  reader = await createUser(admin, 'qrlr')
  author = await createUser(admin, 'qrla')
  const { error } = await admin.from('profiles').insert([
    remoteProfile(quoter, 'Daniel Supernault'),
    remoteProfile(quoted, 'New fediverse apps'),
    remoteProfile(parentAuthor, 'Someone'),
  ])
  if (error) throw new Error(`remote profiles: ${error.message}`)

  const quotedUrl = `https://${quoted.domain}/users/${quoted.username}/statuses/1`
  const quotedContent = [{ type: 'text', text: `New fediverse apps this week #${tag} ${marker}` }]
  const quotedAt = new Date(Date.now() - 3 * 3600_000).toISOString()
  ids.quoted = await insertPost({
    author_id: quoted.id, visibility: 'public', is_local: false, ap_id: quotedUrl, url: quotedUrl,
    content: quotedContent, created_at: quotedAt,
  })
  ids.quote = await insertPost({
    author_id: quoter.id, visibility: 'public', is_local: false,
    ap_id: `https://${quoter.domain}/users/${quoter.username}/statuses/2`,
    content: [{ type: 'text', text: `Test quote post from Columnly ${marker}` }],
    metadata: { is_quote: true, quote_ap_url: quotedUrl, reblog_of: ids.quoted },
    reblog: { id: ids.quoted, content: quotedContent, created_at: quotedAt, visibility: 'public' },
    reblog_author: { id: quoted.id, username: quoted.username, display_name: 'New fediverse apps', domain: quoted.domain, is_local: false },
    created_at: new Date(Date.now() - 3600_000).toISOString(),
  })

  ids.parent = await insertPost({
    author_id: parentAuthor.id, visibility: 'public', is_local: false,
    ap_id: `https://${parentAuthor.domain}/users/${parentAuthor.username}/statuses/3`,
    content: [{ type: 'text', text: `parent on a long domain ${marker}` }],
    created_at: new Date(Date.now() - 120_000).toISOString(),
  })
  ids.reply = await insertPost({
    author_id: author.id, visibility: 'public', is_local: true, in_reply_to: ids.parent,
    content: [{ type: 'text', text: `local answer ${marker}` }],
  })
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [author?.id, quoter.id, quoted.id, parentAuthor.id].filter(Boolean))
  await admin.from('profiles').delete().in('id', [quoter.id, quoted.id, parentAuthor.id])
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

const opened = (page: Page) => page.locator('.post-view article[aria-current="true"]')

async function openQuote(page: Page) {
  await page.goto(`/social/post/${ids.quote}`)
  await expect(opened(page)).toContainText(`Test quote post from Columnly ${marker}`, { timeout: 90_000 })
  const card = opened(page).getByTestId('quoted-post')
  await expect(card).toContainText(`New fediverse apps this week`)
  return card
}

test('the quoted card opens the quoted post, its author and its hashtags', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)

  let card = await openQuote(page)
  // On the words, clear of the hashtag in the same line.
  await card.locator('.quoted-post-content .content-html').click({ position: { x: 8, y: 8 } })
  await expect(page).toHaveURL(new RegExp(`/social/post/${ids.quoted}$`))
  await expect(opened(page)).toContainText(`New fediverse apps this week`, { timeout: 30_000 })

  card = await openQuote(page)
  await card.getByTestId('quoted-author').click()
  await expect(page).toHaveURL(new RegExp(`/social/profile/${quoted.username}@${quoted.domain}$`))

  card = await openQuote(page)
  await card.locator('.hashtag').filter({ hasText: tag }).click()
  await expect(page).toHaveURL(new RegExp(`/social/hashtag/${tag}`))

  card = await openQuote(page)
  const timeLink = card.getByTestId('quoted-post-link')
  await expect(timeLink).toHaveAccessibleName(/^Quoted post by New fediverse apps, /)
  await timeLink.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/social/post/${ids.quoted}$`))
})

test('a reply in a feed names its parent on one line and opens it', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await signIn(page, reader)
  await page.goto('/social/local')
  const post = page.locator('article[data-testid="post-item"]').filter({ hasText: `local answer ${marker}` })
  const line = post.getByTestId('post-reply-line')
  await expect(line).toBeVisible({ timeout: 90_000 })

  const handle = `@${parentAuthor.username}@${parentAuthor.domain}`
  await expect(line).toHaveAttribute('title', `Replying to ${handle}`)
  await expect(line).toHaveAccessibleName(`Replying to ${handle}`)
  const layout = await post.evaluate((article) => {
    const row = article.querySelector('.reply-line') as HTMLElement
    const target = article.querySelector('.reply-line-target') as HTMLElement
    const body = article.querySelector('.post-content') as HTMLElement
    const lineHeight = parseFloat(getComputedStyle(row).lineHeight)
    return {
      rowHeight: row.getBoundingClientRect().height,
      lineHeight,
      truncated: target.scrollWidth > target.clientWidth,
      rowRight: row.getBoundingClientRect().right,
      bodyRight: body.getBoundingClientRect().right,
      articleScroll: article.scrollWidth - article.clientWidth,
    }
  })
  expect(layout.rowHeight).toBeLessThan(layout.lineHeight * 1.5 + 4)
  expect(layout.truncated).toBe(true)
  expect(layout.rowRight).toBeLessThanOrEqual(layout.bodyRight + 0.5)
  expect(layout.articleScroll).toBeLessThanOrEqual(0)

  await line.click()
  await expect(page).toHaveURL(new RegExp(`/social/post/${ids.parent}$`))
  await expect(opened(page)).toContainText(`parent on a long domain ${marker}`, { timeout: 30_000 })
})
