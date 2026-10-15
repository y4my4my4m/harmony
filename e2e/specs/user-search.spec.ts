// Journey: people pickers share one search (src/composables/useUserSearch.ts). Drive's Share
// dialog offers accounts of this instance through search_local_users; the group chat and list
// pickers search through search_federated_users. Each result draws its avatar with <Avatar>, so
// a bucket-relative avatar_url becomes a storage URL rather than a path under the page.
//
// The searched-for account's avatar is a bucket path, `<id>/avatar-e2e.webp`, the shape
// src/views/NewProfile.vue stores.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AVATAR = fs.readFileSync(path.join(ROOT, 'public/default_avatar.webp'))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let owner: SpecUser
let friend: SpecUser

test.beforeAll(async () => {
  owner = await createUser(admin, 'usro')
  friend = await createUser(admin, 'usrf')
  const avatarPath = `${friend.id}/avatar-e2e.webp`
  const { error: uploadError } = await admin.storage
    .from('avatars')
    .upload(avatarPath, AVATAR, { contentType: 'image/webp', upsert: true })
  if (uploadError) throw new Error(`avatar upload: ${uploadError.message}`)
  const { error } = await admin.from('profiles').update({ avatar_url: avatarPath }).eq('id', friend.id)
  if (error) throw new Error(`avatar_url: ${error.message}`)
})

test.afterAll(async () => {
  await admin.storage.from('avatars').remove([`${friend?.id}/avatar-e2e.webp`]).catch(() => {})
  await deleteUser(admin, friend)
  await deleteUser(admin, owner)
})

/** The avatar decoded an image, and its src is the friend's storage object, not a page URL. */
async function expectFriendAvatar(page: Page, img: Locator) {
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 15000 })
    .toBeGreaterThan(0)
  const src = await img.evaluate((el: HTMLImageElement) => el.currentSrc || el.src)
  const url = new URL(src, page.url())
  expect(url.origin).not.toBe(new URL(page.url()).origin)
  expect(url.pathname).toMatch(/^\/storage\/v1\/(object|render\/image)\/public\/avatars\//)
  expect(url.pathname).toContain(`${friend.id}/avatar-e2e.webp`)
}

test('Drive share finds a local account by part of its name, with its avatar, and shares with it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)

  await test.step('a file in Drive opens its Share dialog', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
    await dismissAnnouncements(page)
    await page.getByTestId('drive-layout-list').click()
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'plans.png', mimeType: 'image/png', buffer: PNG })
    const row = page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: 'plans.png' })
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click()
    await page.getByTestId('drive-share-open').click()
    await expect(page.getByTestId('drive-share-dialog')).toBeVisible()
  })

  const dialog = page.getByTestId('drive-share-dialog')
  const search = dialog.getByTestId('drive-share-search')
  const person = dialog.getByTestId('drive-share-person')

  await test.step('the owner is not offered to themselves', async () => {
    await search.fill(owner.username)
    await expect(dialog.getByTestId('drive-share-status')).toHaveText('Nobody on this instance matches', { timeout: 10000 })
    await expect(person).toHaveCount(0)
  })

  await test.step('part of a name finds the account through search_local_users, quickly', async () => {
    const answered = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/search_local_users') && r.status() === 200)
    const started = Date.now()
    await search.fill(friend.username.slice(0, -3))
    await answered
    await expect(person).toHaveCount(1, { timeout: 3000 })
    expect(Date.now() - started).toBeLessThan(3000)
    await expect(person).toContainText(friend.displayName)
    await expect(person).toContainText(`@${friend.username}`)
  })

  await test.step('its avatar is the stored image', async () => {
    await expectFriendAvatar(page, person.getByTestId('drive-share-person-avatar').locator('img'))
  })

  await test.step('choosing it shares the file with that account', async () => {
    await person.click()
    await expect(dialog.getByTestId('drive-share-list')).toContainText(friend.displayName)
    await expect(search).toHaveValue('')
    await expect.poll(async () => {
      const { data } = await admin.from('drive_shares').select('id').eq('scope', 'user').eq('target_id', friend.id)
      return data?.length ?? 0
    }, { timeout: 10000 }).toBe(1)
  })

  await test.step('an account the file is shared with is not offered again', async () => {
    await search.fill(friend.username)
    await expect(dialog.getByTestId('drive-share-status')).toHaveText('Nobody on this instance matches', { timeout: 10000 })
    await expect(person).toHaveCount(0)
  })
})

test('the group chat picker shows a found account with its avatar', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto('/dm')
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="dm-sidebar"]')).toBeVisible({ timeout: 30000 })

  await page.getByRole('button', { name: 'Create group chat' }).click()
  await page.getByTestId('group-invite-search').fill(friend.username.slice(0, -3))
  const result = page.getByTestId('group-invite-result').filter({ hasText: friend.username })
  await expect(result).toHaveCount(1, { timeout: 10000 })
  await expectFriendAvatar(page, result.locator('.avatar-container img'))

  await result.click()
  await expect(page.getByText('Selected users (1)')).toBeVisible()
  await expect(result).toHaveCount(0)
})

test('the list member picker shows a found account with its avatar and adds it', async ({ page }) => {
  test.setTimeout(120_000)
  const { error: followError } = await admin
    .from('follows')
    .insert({ follower_id: owner.id, following_id: friend.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)
  const { data: list, error: listError } = await admin
    .from('user_lists')
    .insert({ user_id: owner.id, title: `Friends ${owner.username}` })
    .select('id')
    .single()
  if (listError || !list) throw new Error(`list: ${listError?.message}`)

  await signIn(page, owner)
  await page.goto(`/social/lists/${list.id}`)
  await dismissAnnouncements(page)
  await page.getByTestId('list-members-toggle').click()
  await page.getByTestId('list-member-search').fill(friend.username.slice(0, -3))

  const result = page.getByTestId('list-member-result').filter({ hasText: friend.username })
  await expect(result).toHaveCount(1, { timeout: 10000 })
  await expectFriendAvatar(page, result.locator('.avatar-container img'))

  await result.getByRole('button', { name: /^Add / }).click()
  await expect(result.getByRole('button', { name: /^Added / })).toBeDisabled({ timeout: 10000 })
  await expect(page.getByRole('list', { name: 'Members' })).toContainText(friend.displayName)
})
