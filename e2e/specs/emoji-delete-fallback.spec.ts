// Journey: what removing and purging a custom emoji leaves behind (20261107100001_emoji_lifecycle).
//
// The owner uploads a server emoji (storage object + create_server_emoji). A member sends it in
// a message from the composer, writes it in a post, and reacts with it. The owner removes it:
// it leaves the member's picker and autocomplete, while the old message, post and reaction
// still draw it (the image loads) and its file stays in storage. An instance admin then purges
// it from Admin › Emojis: the file is deleted, and the message, the post and the reaction show
// the broken-image icon with :name:, never an empty <img>.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

// 16x16 opaque PNG: imgproxy renders it at the requested emoji size.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR42mP8z8AARMQBxlGF1FUIAMJVAf8zYy5CAAAAAElFTkSuQmCC',
  'base64',
)

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let staff: SpecUser
let server: SeededServer
let name: string
let emojiId: string
let path: string
let messageId: string
let postId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'edfown')
  member = await createUser(admin, 'edfmem')
  staff = await createUser(admin, 'edfadm')
  const { error: adminError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (adminError) throw new Error(`admin: ${adminError.message}`)
  server = await seedServer(admin, owner, `Fallback ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)
  name = `gone${owner.username.slice(-6)}`

  // The owner's client uploads as Server settings › Emoji does.
  const asOwner = await userClient(owner)
  path = `${server.id}/${owner.id}/${crypto.randomUUID()}.png`
  const { error: uploadError } = await asOwner.storage.from('emojis').upload(path, PNG, { contentType: 'image/png' })
  if (uploadError) throw new Error(`upload: ${uploadError.message}`)
  const url = asOwner.storage.from('emojis').getPublicUrl(path).data.publicUrl
  const { data: emoji, error } = await asOwner.rpc('create_server_emoji', {
    p_server_id: server.id, p_name: name, p_path: path, p_url: url,
  })
  if (error || !emoji) throw new Error(`create_server_emoji: ${error?.message}`)
  emojiId = (emoji as { id: string }).id

  // The post as CorePostService writes it; check_content_emoji_parts takes the part from the row.
  const asMember = await userClient(member)
  const { data: post, error: postError } = await asMember.from('posts')
    .insert({
      author_id: member.id, visibility: 'public', is_local: true,
      content: [{ type: 'text', text: `post with ` }, { type: 'emoji', emoji: { id: emojiId, name, url } }],
      metadata: { created_via: 'harmony_client', content_format: 'message_parts_v1' },
    })
    .select('id, content').single()
  if (postError || !post) throw new Error(`post: ${postError?.message}`)
  postId = post.id
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('id', postId ?? '')
  await admin.from('emojis').delete().eq('id', emojiId ?? '')
  if (path) await admin.storage.from('emojis').remove([path])
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
  await deleteUser(admin, staff)
})

const editor = (page: Page) => page.locator('[data-region="composer"] [contenteditable="true"]').first()
const messageRow = (page: Page) => page.locator(`[data-testid="message-list"] .message-item[data-message-id="${messageId}"]`)
const postItem = (page: Page) => page.locator(`[data-testid="post-item"][data-post-id="${postId}"]`)

/** Every inline <img> of the emoji in `scope` has loaded with a size. */
async function emojiImagesLoaded(scope: ReturnType<Page['locator']>): Promise<boolean> {
  const imgs = scope.locator(`img.emoji-icon[alt=":${name}:"]`)
  if ((await imgs.count()) === 0) return false
  return imgs.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
}

/** No emoji <img> of `scope` is drawn without an image. */
async function noEmptyEmojiImages(scope: ReturnType<Page['locator']>): Promise<boolean> {
  return scope.locator('img.emoji-icon, img.reaction-emoji').evaluateAll((els) =>
    els.every((el) => getComputedStyle(el).display === 'none' || ((el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)))
}

async function objectExists(): Promise<boolean> {
  const folder = path.slice(0, path.lastIndexOf('/'))
  const { data } = await admin.storage.from('emojis').list(folder)
  return (data ?? []).some((o) => `${folder}/${o.name}` === path)
}

test('a removed emoji leaves the picker but old content still draws it; a purge leaves the broken-image icon', async ({ page: first }) => {
  let page = first
  test.setTimeout(300_000)

  await test.step('the member sends it from the composer and reacts with it', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    await editor(page).click()
    await page.keyboard.type(`:${name}`)
    const option = page.locator('[role="option"]').filter({ hasText: name })
    await expect(option).toHaveCount(1, { timeout: 15000 })
    await option.click()
    await page.keyboard.type(' still here')
    await page.keyboard.press('Enter')
    const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'still here' }).last()
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    messageId = (await row.getAttribute('data-message-id'))!
    const { data } = await admin.from('messages').select('content').eq('id', messageId).single()
    expect((data!.content as Array<{ type: string; emoji?: { id?: string } }>).find((p) => p.type === 'emoji')?.emoji?.id).toBe(emojiId)

    const asMember = await userClient(member)
    const { error } = await asMember.from('reactions').insert({ message_id: messageId, user_id: member.id, emoji_id: emojiId })
    expect(error).toBeNull()
  })

  await test.step('the owner removes it', async () => {
    const asOwner = await userClient(owner)
    const { error } = await asOwner.rpc('remove_emoji', { p_emoji_id: emojiId })
    expect(error).toBeNull()
    const { data } = await admin.from('emojis').select('deleted_at').eq('id', emojiId).single()
    expect(data?.deleted_at).not.toBeNull()
    expect(await objectExists()).toBe(true)
  })

  await test.step('it is gone from the member\'s autocomplete and picker', async () => {
    await page.reload()
    await openChannel(page, server.id, server.generalChannelId)
    await expect(messageRow(page)).toBeVisible({ timeout: 30000 })
    await editor(page).click()
    await page.keyboard.type(`:${name}`)
    await expect(page.getByRole('listbox').getByRole('option').filter({ hasText: name })).toHaveCount(0)
    await page.waitForTimeout(1500)
    await expect(page.locator('[role="option"]').filter({ hasText: name })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')

    await page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' }).click()
    const picker = page.locator('[data-testid="media-picker"]')
    await expect(picker).toBeVisible({ timeout: 15000 })
    await picker.locator('.search-input').fill(name)
    await page.waitForTimeout(1000)
    await expect(picker.getByRole('button', { name: `:${name}:` })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  await test.step('the old message, its reaction and the post still draw it', async () => {
    await expect.poll(() => emojiImagesLoaded(messageRow(page)), { timeout: 30000 }).toBe(true)
    await expect.poll(() => messageRow(page).locator('img.reaction-emoji').evaluateAll((els) =>
      els.length === 1 && els.every((el) => (el as HTMLImageElement).naturalWidth > 0)), { timeout: 30000 }).toBe(true)

    await page.goto(`/posts/${postId}`)
    await expect(postItem(page).first()).toBeVisible({ timeout: 60000 })
    await expect.poll(() => emojiImagesLoaded(postItem(page).first()), { timeout: 30000 }).toBe(true)
  })

  await test.step('an admin purges it from Admin › Emojis', async () => {
    const staffPage = await page.context().browser()!.newPage()
    await signIn(staffPage, staff)
    await staffPage.goto('/admin?tab=emojis')
    const library = staffPage.getByTestId('admin-emoji-library')
    await expect(library).toBeVisible({ timeout: 30000 })
    await library.getByTestId('admin-emoji-kind-server').click()
    await library.getByTestId('admin-emoji-status').selectOption('removed')
    await library.getByTestId('admin-emoji-search').fill(name)
    const row = library.locator(`[data-testid="admin-emoji-row"][data-emoji-id="${emojiId}"]`)
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.getByRole('button', { name: `Purge :${name}:` }).click()
    const dialog = staffPage.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Purge', exact: true }).click()
    await expect(row).toHaveCount(0, { timeout: 30000 })
    await staffPage.close()

    await expect.poll(async () => (await admin.from('emojis').select('id').eq('id', emojiId)).data?.length).toBe(0)
    await expect.poll(objectExists, { timeout: 15000 }).toBe(false)
    const { data: reaction } = await admin.from('reactions').select('emoji_id, custom_emoji_content').eq('message_id', messageId).single()
    expect(reaction).toEqual({ emoji_id: null, custom_emoji_content: `:${name}:` })
  })

  // A fresh context: this page's HTTP and service-worker caches still hold the image.
  await test.step('the message, the reaction and the post show the broken-image icon', async () => {
    const context = await page.context().browser()!.newContext()
    page = await context.newPage()
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    const row = messageRow(page)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row.locator(`.emoji-fallback[title=":${name}:"]`)).toHaveCount(1, { timeout: 30000 })
    await expect(row.getByTestId('reaction-emoji-removed')).toHaveAttribute('aria-label', `:${name}:`, { timeout: 30000 })
    expect(await noEmptyEmojiImages(row)).toBe(true)

    await page.goto(`/posts/${postId}`)
    const post = postItem(page).first()
    await expect(post).toBeVisible({ timeout: 60000 })
    await expect(post.locator(`.emoji-fallback[title=":${name}:"]`)).toHaveCount(1, { timeout: 30000 })
    expect(await noEmptyEmojiImages(post)).toBe(true)
    await context.close()
  })
})
