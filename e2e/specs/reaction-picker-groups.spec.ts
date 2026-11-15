// Journey: every emoji picker lists the same groups, and the custom emojis of a server hosted
// on another instance are offered in its channels.
//
//   - The reaction picker, opened before any other picker, lists My Emoji and the instance's
//     emoji, as the composer's picker does.
//   - A copy's emojis (rows the federation backend stores from the host Group's harmony:emojis,
//     services/CopyMirrorService.applyGroupEmojis) form the copy's section in the reaction picker
//     of its channel; a reaction with one is stored on that row.
//   - In the mobile layout neither picker puts focus in its search field, which would raise the
//     on-screen keyboard over the list.
//
// This stack has no federation backend: the copy's rows are written here as it writes them.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, messageList, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let user: SpecUser
let server: SeededServer
const emojiIds: string[] = []
const stored: string[] = []
let instanceEmoji = ''

const host = 'emoji-host.example'
const hostOwner = { id: crypto.randomUUID(), username: `peh${Date.now().toString(36)}` }
const copy = { id: crypto.randomUUID(), name: 'Hall Across', channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${copy.id}`
const hostEmoji = { id: crypto.randomUUID(), hostId: crypto.randomUUID(), name: '' }
const TEXT = { local: 'react to this here', remote: 'react to this over there' }

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

async function image(name: string): Promise<string> {
  const objectPath = `${user.id}/${name}.png`
  await must(`upload ${name}`, admin.storage.from('emojis').upload(objectPath, PNG, { contentType: 'image/png', upsert: true }))
  stored.push(objectPath)
  return admin.storage.from('emojis').getPublicUrl(objectPath).data.publicUrl
}

async function personal(scope: 'user' | 'instance', name: string): Promise<void> {
  const { data } = await must(`emoji ${name}`, admin.from('emojis')
    .insert({ name, url: await image(name), server_id: null, domain: null, scope, uploader: scope === 'user' ? user.id : null })
    .select('id').single())
  emojiIds.push(data!.id)
}

/** A message with one reaction, so its reactions row carries the add-reaction button. */
async function reacted(channelId: string, authorId: string, text: string, remote: boolean): Promise<string> {
  const id = crypto.randomUUID()
  await must(`message ${text}`, admin.from('messages').insert({
    id, channel_id: channelId, user_id: authorId, content: [{ type: 'text', text }],
    ...(remote ? { federation_status: 'skipped', metadata: { ap_id: `https://${host}/messages/${id}`, is_remote: true, federated: true } } : {}),
  }))
  await must(`reaction on ${text}`, admin.from('reactions').insert({ message_id: id, user_id: user.id, custom_emoji_content: '👍' }))
  return id
}

test.beforeAll(async () => {
  user = await createUser(admin, 'rpg')
  server = await seedServer(admin, user, `Pickers ${user.username}`)
  await personal('user', `mine_${user.username}`.slice(0, 32))
  instanceEmoji = `inst_${user.username}`.slice(0, 32)
  await personal('instance', instanceEmoji)
  await reacted(server.generalChannelId, user.id, TEXT.local, false)

  await must('host owner', admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: 'Host Owner', domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  }))
  await must('copy', admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', copy.id)
  await must('copy channel', admin.from('channels').insert({
    id: copy.channel, server_id: copy.id, name: 'general', type: 0, order: 0, is_remote: true, ap_id: `${groupUrl}/channels/${copy.channel}`,
  }))
  await must('memberships', admin.from('user_servers').upsert([
    { server_id: copy.id, user_id: user.id, status: 'accepted', member_instance: 'localhost' },
    { server_id: copy.id, user_id: hostOwner.id, status: 'accepted', member_instance: host },
  ], { onConflict: 'user_id,server_id' }))
  hostEmoji.name = `hall_${user.username}`.slice(0, 32)
  await must('copy emoji', admin.from('emojis').insert({
    id: hostEmoji.id, name: hostEmoji.name, url: await image(hostEmoji.name), server_id: copy.id, scope: 'server',
    domain: host, ap_id: `${groupUrl}/emojis/${hostEmoji.hostId}`,
  }))
  emojiIds.push(hostEmoji.id)
  await reacted(copy.channel, hostOwner.id, TEXT.remote, true)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  if (emojiIds.length) await admin.from('emojis').delete().in('id', emojiIds)
  if (stored.length) await admin.storage.from('emojis').remove(stored)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, user)
})

const reactionPicker = (page: Page) => page.getByRole('dialog', { name: 'Add reaction' })
const rowOf = (page: Page, text: string) =>
  messageList(page).getByRole('article').filter({ has: page.locator('[id^="msg-body-"]', { hasText: text }) })
const sectionNamed = (page: Page, name: string | RegExp) =>
  reactionPicker(page).locator('.section-title-collapsible', { hasText: name })

async function stubCopyRoutes(page: Page): Promise<void> {
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route('**/servers/*/sync', (route) => route.fulfill({ json: { success: true, message: 'Server synced' } }))
}

test('the reaction picker lists My Emoji and the instance\'s emoji on its first open', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  const row = rowOf(page, TEXT.local)
  await expect(row).toBeVisible({ timeout: 20000 })
  await row.getByTestId('add-reaction-btn').click()
  await expect(reactionPicker(page)).toBeVisible()
  await expect(sectionNamed(page, 'My Emoji')).toBeVisible({ timeout: 15000 })
  await expect(reactionPicker(page).getByRole('button', { name: `:${instanceEmoji}:`, exact: true }).first()).toBeAttached()
  await expect(reactionPicker(page).locator('input.search-input')).toBeFocused()
})

test('a copy offers its host\'s emojis in its channel, and a reaction with one is stored on that row', async ({ page }) => {
  test.setTimeout(120_000)
  await stubCopyRoutes(page)
  await signIn(page, user)
  await openChannel(page, copy.id, copy.channel)
  const row = rowOf(page, TEXT.remote)
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.getByTestId('add-reaction-btn').click()
  await expect(sectionNamed(page, copy.name)).toBeVisible({ timeout: 15000 })
  const emoji = reactionPicker(page).getByRole('button', { name: `:${hostEmoji.name}:`, exact: true })
  await expect.poll(() => emoji.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15000 }).toBe(true)
  await emoji.click()
  await expect(reactionPicker(page)).toBeHidden()
  await expect.poll(async () => {
    const { data } = await admin.from('reactions').select('emoji_id').eq('user_id', user.id).not('emoji_id', 'is', null)
      .in('message_id', (await admin.from('messages').select('id').eq('channel_id', copy.channel)).data?.map((m) => m.id) ?? [])
    return data?.map((r) => r.emoji_id) ?? []
  }, { timeout: 15000 }).toEqual([hostEmoji.id])
  await expect(row.getByRole('button', { name: new RegExp(hostEmoji.name) })).toBeVisible()
})

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('neither picker puts focus in its search field', async ({ page }) => {
    test.setTimeout(90_000)
    await signIn(page, user)
    await openChannel(page, server.id, server.generalChannelId)
    const row = rowOf(page, TEXT.local)
    await expect(row).toBeVisible({ timeout: 20000 })

    await row.getByTestId('add-reaction-btn').click()
    const reaction = reactionPicker(page)
    await expect(reaction).toBeVisible()
    await expect(sectionNamed(page, 'My Emoji')).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(300)
    await expect(reaction.locator('input.search-input')).not.toBeFocused()
    await expect.poll(() => reaction.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(reaction).toBeHidden()

    await page.locator('[data-region="composer"]').getByRole('button', { name: /emoji/i }).last().click()
    const media = page.locator('.media-picker-popup').first()
    await expect(media).toBeVisible({ timeout: 15000 })
    await expect(media.locator('.section-title-collapsible', { hasText: 'My Emoji' })).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(300)
    await expect(media.locator('input.search-input')).not.toBeFocused()
  })
})
