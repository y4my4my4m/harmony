// Journey: the social side names this instance's staff as instance staff. The Admin and Mod
// badges on a profile and on a post are titled "Instance administrator" and "Instance
// moderator": "server" is a community on Harmony.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let viewer: SpecUser
let staffAdmin: SpecUser
let staffMod: SpecUser
let postId = ''

test.beforeAll(async () => {
  viewer = await createUser(admin, 'isw')
  staffAdmin = await createUser(admin, 'iswa')
  staffMod = await createUser(admin, 'iswm')
  const promoted = await admin.from('profiles').update({ is_admin: true }).eq('id', staffAdmin.id)
  if (promoted.error) throw new Error(`admin: ${promoted.error.message}`)
  const moderator = await admin.from('profiles').update({ is_moderator: true }).eq('id', staffMod.id)
  if (moderator.error) throw new Error(`moderator: ${moderator.error.message}`)
  const { data, error } = await admin.from('posts')
    .insert({
      author_id: staffAdmin.id,
      content: [{ type: 'text', text: 'Maintenance tonight at 22:00' }],
      visibility: 'public',
      is_local: true,
    })
    .select('id').single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  postId = data.id
})

test.afterAll(async () => {
  if (postId) await admin.from('posts').delete().eq('id', postId)
  await deleteUser(admin, staffMod)
  await deleteUser(admin, staffAdmin)
  await deleteUser(admin, viewer)
})

test('profile badges name the instance administrator and moderator', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, viewer)

  await page.goto(`/social/profile/@${staffAdmin.username}`)
  const adminBadge = page.locator('.instance-badge.admin').first()
  await expect(adminBadge).toBeVisible({ timeout: 30000 })
  await expect(adminBadge).toHaveAttribute('title', 'Instance administrator')

  await page.goto(`/social/profile/@${staffMod.username}`)
  const modBadge = page.locator('.instance-badge.mod').first()
  await expect(modBadge).toBeVisible({ timeout: 30000 })
  await expect(modBadge).toHaveAttribute('title', 'Instance moderator')
})

test('a post by an instance administrator carries the same title', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, viewer)
  await page.goto(`/social/post/${postId}`)
  const badge = page.locator('.mony-post .instance-badge').first()
  await expect(badge).toBeVisible({ timeout: 30000 })
  await expect(badge).toHaveAttribute('title', 'Instance administrator')
})
