// Journey: the author of a post sees who favourited and boosted it. On the post page the
// favourites and boosts counts are buttons; each opens one dialog with a Favorites and a Boosts
// tab, on the tab clicked. Accounts are listed newest first and link to their profiles, a remote
// account by its full handle. A favourites count above the rows stored here ends the list with
// the number of accounts on other servers. Escape closes the dialog and focus returns to the
// count it was opened from.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
const DOMAIN = 'likes.example'
let author: SpecUser
let bea: SpecUser
let cal: SpecUser
let postId = ''
const remote = { id: randomUUID(), username: `rfav${Date.now().toString(36)}` }

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

test.beforeAll(async () => {
  author = await createUser(admin, 'pia')
  bea = await createUser(admin, 'pib')
  cal = await createUser(admin, 'pic')

  const actor = `https://${DOMAIN}/users/${remote.username}`
  const profile = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote Fan',
    domain: DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (profile.error) throw new Error(`remote profile: ${profile.error.message}`)

  const post = await admin.from('posts').insert({
    author_id: author.id,
    is_local: true,
    visibility: 'public',
    content: [{ type: 'text', text: 'who liked this?' }],
  }).select('id').single()
  if (post.error) throw new Error(`post: ${post.error.message}`)
  postId = post.data!.id

  const rows = [
    { user_id: bea.id, interaction_type: 'favorite', created_at: minutesAgo(30) },
    { user_id: cal.id, interaction_type: 'favorite', created_at: minutesAgo(20) },
    { user_id: remote.id, interaction_type: 'favorite', created_at: minutesAgo(10), is_local: false, federation_status: 'completed', ap_id: `${actor}#likes/1` },
    { user_id: cal.id, interaction_type: 'reblog', created_at: minutesAgo(5) },
  ]
  for (const row of rows) {
    const { error } = await admin.from('post_interactions').insert({ post_id: postId, ...row })
    if (error) throw new Error(`${row.interaction_type} by ${row.user_id}: ${error.message}`)
  }

  // Two more favourites are known only to other servers.
  const counts = await admin.from('posts').update({ favorites_count: 5, reblogs_count: 1 }).eq('id', postId)
  if (counts.error) throw new Error(`counts: ${counts.error.message}`)
})

test.afterAll(async () => {
  if (postId) await admin.from('posts').delete().eq('id', postId)
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, author)
  await deleteUser(admin, bea)
  await deleteUser(admin, cal)
})

async function openPost(page: Page) {
  await page.goto(`/social/post/${postId}`)
  await dismissAnnouncements(page)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })
  return post
}

test('the author lists who favourited and boosted the post', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, author)
  const post = await openPost(page)

  const favorites = post.getByRole('button', { name: '5 favorites, show who' })
  await expect(favorites).toBeVisible()
  await expect(favorites).toHaveText('5 favorites')
  await expect(post.getByRole('button', { name: '1 boost, show who' })).toBeVisible()

  await favorites.click()
  const dialog = page.getByRole('dialog', { name: 'Favorites and boosts' })
  await expect(dialog).toBeVisible()
  const favoritesTab = dialog.getByRole('tab', { name: /Favorites/ })
  await expect(favoritesTab).toHaveAttribute('aria-selected', 'true')
  await expect(favoritesTab).toBeFocused()

  const panel = dialog.getByRole('tabpanel')
  const accounts = panel.getByTestId('post-interactions-account')
  await expect(accounts).toHaveCount(3)
  await expect(accounts.nth(0)).toContainText('Remote Fan')
  await expect(accounts.nth(0)).toContainText(`@${remote.username}@${DOMAIN}`)
  await expect(accounts.nth(0)).toHaveAttribute('href', new RegExp(`/social/profile/${remote.username}(@|%40)${DOMAIN.replace('.', '\\.')}$`))
  await expect(accounts.nth(1)).toContainText(cal.displayName)
  await expect(accounts.nth(1)).toContainText(`@${cal.username}`)
  await expect(accounts.nth(1)).toHaveAttribute('href', `/social/profile/${cal.username}`)
  await expect(accounts.nth(2)).toContainText(bea.displayName)
  await expect(accounts.nth(2)).toHaveAttribute('href', `/social/profile/${bea.username}`)
  await expect(panel.getByTestId('post-interactions-elsewhere')).toHaveText("2 more on other servers aren't listed here.")

  await page.keyboard.press('ArrowRight')
  const boostsTab = dialog.getByRole('tab', { name: /Boosts/ })
  await expect(boostsTab).toHaveAttribute('aria-selected', 'true')
  await expect(boostsTab).toBeFocused()
  await expect(accounts).toHaveCount(1)
  await expect(accounts.first()).toContainText(cal.displayName)
  await expect(accounts.first()).toHaveAttribute('href', `/social/profile/${cal.username}`)
  await expect(panel.getByTestId('post-interactions-elsewhere')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(favorites).toBeFocused()

  await post.getByRole('button', { name: '1 boost, show who' }).click()
  await expect(dialog.getByRole('tab', { name: /Boosts/ })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByTestId('post-interactions-account').first().click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/social/profile/${cal.username}$`))
})

test('a backdrop click closes the dialog', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, bea)
  const post = await openPost(page)

  const boosts = post.getByRole('button', { name: '1 boost, show who' })
  await boosts.click()
  const dialog = page.getByRole('dialog', { name: 'Favorites and boosts' })
  await expect(dialog.getByTestId('post-interactions-account')).toHaveCount(1)
  await page.mouse.click(5, 5)
  await expect(dialog).toBeHidden()
  await expect(boosts).toBeFocused()
})
