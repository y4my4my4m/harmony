// Journey: a fediverse post with a picture from Drive. The post composer's Drive button lists
// chat files and post media; a chat file (private) is copied into public post media when the
// post is sent, so the post federates a public URL while the Drive original stays private.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'dpost')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('a Drive picture posts as public post media', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, user)

  await test.step('the picture is in Drive', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
    await dismissAnnouncements(page)
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'harbour.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.getByTestId('drive-file').filter({ hasText: 'harbour.png' })).toBeVisible({ timeout: 30000 })
  })

  const text = `from drive ${user.username}`
  await test.step('the post composer attaches it from Drive and posts it', async () => {
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'New post' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a post' })
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await dialog.locator('.rich-text-editor').click()
    await page.keyboard.type(text)
    await dialog.getByTestId('compose-from-drive').click()
    await page.getByTestId('drive-picker').getByTestId('drive-picker-file').filter({ hasText: 'harbour.png' }).click()
    await page.getByTestId('drive-picker-confirm').click()
    await expect(dialog.locator('img[src*="message_media"]')).toHaveCount(1)
    await dialog.getByTestId('compose-submit').click()
    await expect(dialog).toBeHidden({ timeout: 30000 })
  })

  await test.step('the post names a public copy; the Drive original stays private', async () => {
    let media: Array<{ url: string }> = []
    await expect.poll(async () => {
      const { data } = await admin.from('posts').select('media_attachments').eq('author_id', user.id).maybeSingle()
      media = (data?.media_attachments as Array<{ url: string }> | null) ?? []
      return media.length
    }, { timeout: 15000 }).toBe(1)
    expect(media[0].url).toMatch(new RegExp(`/storage/v1/object/public/user_media/${user.id}/posts/[0-9a-f-]+\\.png$`))
    const copy = await fetch(media[0].url)
    expect(copy.status).toBe(200)

    const { data: files } = await admin.from('drive_files').select('bucket').eq('owner_id', user.id)
    expect((files ?? []).map((f) => f.bucket).sort()).toEqual(['message_media', 'user_media'])
  })
})
