// Journey: EMBED_LINKS, USE_EXTERNAL_EMOJIS and READ_MESSAGE_HISTORY hold for members, and a
// role's channel Allow restores each.
//
// - #links denies EMBED_LINKS to @everyone: a member's link posts as a link, stored with embeds
//   suppressed, and shows no preview card once a preview exists; the member cannot restore it.
// - #emoji denies USE_EXTERNAL_EMOJIS: the picker shows this server's emoji only and says so,
//   this server's emoji posts, another server's is refused with a notice, and so is a reaction
//   with it.
// - #history denies READ_MESSAGE_HISTORY: as on Discord, a member sees only messages sent since
//   they opened the channel in this session of the app, and a note says why. Earlier messages,
//   from before or after joining, stay hidden; one sent while the channel is open shows; after a
//   reload it is earlier than the new view and hides again.
// - A second member holds a role whose channel overrides Allow all three: the preview card
//   shows, the other server's emoji is offered and posts, and the whole history reads.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  addMember,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()

// Bit positions in permission_bit_names().
const EMBED_LINKS = 2 ** 16
const USE_EXTERNAL_EMOJIS = 2 ** 19
const READ_MESSAGE_HISTORY = 2 ** 22

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const EXTERNAL_NOTICE = "Only unicode and this server's emoji can be used in this channel."
const HISTORY_NOTE = "Messages sent before you opened this channel are hidden: you don't have Read Message History in this channel."

let owner: SpecUser
let member: SpecUser
let trusted: SpecUser
let server: SeededServer
let elsewhere: SeededServer
let linksId: string
let emojiId: string
let historyId: string
let localEmoji: { id: string; name: string }
let farEmoji: { id: string; name: string }
let reactTargetId: string
let beforeId: string
let afterId: string
const stored: string[] = []

async function override(channelId: string, roleId: string, allow: number, deny: number): Promise<void> {
  const { error } = await admin.from('channel_permission_overrides').insert({
    channel_id: channelId, target_type: 'role', role_id: roleId, allow_permissions: allow, deny_permissions: deny,
  })
  if (error) throw new Error(`override: ${error.message}`)
}

async function everyoneRole(serverId: string): Promise<string> {
  const { data, error } = await admin.from('server_roles').select('id').eq('server_id', serverId).eq('is_default', true).single()
  if (error || !data) throw new Error(`@everyone: ${error?.message}`)
  return data.id
}

async function serverEmoji(serverId: string, name: string): Promise<{ id: string; name: string }> {
  const objectPath = `${owner.id}/${name}.png`
  const { error: uploadError } = await admin.storage.from('emojis').upload(objectPath, PNG, { contentType: 'image/png', upsert: true })
  if (uploadError) throw new Error(`emoji upload: ${uploadError.message}`)
  stored.push(objectPath)
  const url = admin.storage.from('emojis').getPublicUrl(objectPath).data.publicUrl
  const { data, error } = await admin
    .from('emojis')
    .insert({ name, url, server_id: serverId, scope: 'server', uploader: owner.id })
    .select('id')
    .single()
  if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
  return { id: data.id, name }
}

async function seedMessage(channelId: string, text: string): Promise<string> {
  const { data, error } = await admin
    .from('messages')
    .insert({ channel_id: channelId, user_id: owner.id, content: [{ type: 'text', text }] })
    .select('id')
    .single()
  if (error || !data) throw new Error(`message: ${error?.message}`)
  return data.id
}

/** The row the member's composer stored for `url`; its preview is then written as the link-preview worker writes it. */
async function linkMessage(author: SpecUser, channelId: string, url: string) {
  const { data, error } = await admin
    .from('messages')
    .select('id, metadata')
    .eq('channel_id', channelId)
    .eq('user_id', author.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (error || !data) throw new Error(`link message: ${error?.message}`)
  const { error: embedError } = await admin.rpc('update_message_embeds', {
    p_message_id: data.id,
    p_embeds: {
      [url]: {
        cacheKey: url, url, normalizedUrl: url, provider: 'generic', title: 'Preview of the page',
        description: 'A page with a preview', fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  })
  if (embedError) throw new Error(`embeds: ${embedError.message}`)
  return data as { id: string; metadata: Record<string, unknown> | null }
}

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })
const channelItem = (page: Page, id: string) => page.locator(`.channel-sidebar .channel-wrapper[data-channel-id="${id}"] .channel-item`)

/** Where the member's view of the channel starts, as begin_channel_history_view stored it. */
async function viewStart(user: SpecUser, channelId: string): Promise<string | null> {
  const { data } = await admin.from('channel_history_views').select('since').eq('user_id', user.id).eq('channel_id', channelId).maybeSingle()
  return data?.since ?? null
}
const emojiTrigger = (page: Page) => page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' })
const picker = (page: Page) => page.locator('[data-testid="media-picker"]')

async function openEmojiTab(page: Page): Promise<void> {
  await emojiTrigger(page).click()
  await expect(picker(page)).toBeVisible({ timeout: 15000 })
  const tab = picker(page).getByRole('tab', { name: 'Emoji' })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'mcpown')
  member = await createUser(admin, 'mcpmem')
  trusted = await createUser(admin, 'mcptru')
  server = await seedServer(admin, owner, `Content ${owner.username}`)
  elsewhere = await seedServer(admin, owner, `Elsewhere ${owner.username}`)
  linksId = await addChannel(admin, server, 'links')
  emojiId = await addChannel(admin, server, 'emoji')
  historyId = await addChannel(admin, server, 'history')

  const everyone = await everyoneRole(server.id)
  await override(linksId, everyone, 0, EMBED_LINKS)
  await override(emojiId, everyone, 0, USE_EXTERNAL_EMOJIS)
  await override(historyId, everyone, 0, READ_MESSAGE_HISTORY)

  localEmoji = await serverEmoji(server.id, `loc_${owner.username}`.slice(0, 32))
  farEmoji = await serverEmoji(elsewhere.id, `far_${owner.username}`.slice(0, 32))

  beforeId = await seedMessage(historyId, 'History from before you joined')
  for (const user of [member, trusted]) {
    await addMember(admin, user, server.id)
    await addMember(admin, user, elsewhere.id)
  }
  afterId = await seedMessage(historyId, 'History from after you joined')
  reactTargetId = await seedMessage(emojiId, 'React to this')

  const { data: role, error: roleError } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name: 'Trusted', position: 1, permissions: 0 })
    .select('id')
    .single()
  if (roleError || !role) throw new Error(`role: ${roleError?.message}`)
  const { error: assignError } = await admin.from('user_roles').insert({ user_id: trusted.id, role_id: role.id, server_id: server.id })
  if (assignError) throw new Error(`assign: ${assignError.message}`)
  await override(linksId, role.id, EMBED_LINKS, 0)
  await override(emojiId, role.id, USE_EXTERNAL_EMOJIS, 0)
  await override(historyId, role.id, READ_MESSAGE_HISTORY, 0)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', [localEmoji?.id, farEmoji?.id].filter(Boolean))
  if (stored.length) await admin.storage.from('emojis').remove(stored)
  for (const user of [owner, member, trusted]) await deleteUser(admin, user)
})

test('a member without the three permissions', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, member)

  await test.step('#links: a link posts without a preview, and its embeds stay off', async () => {
    const url = `https://example.com/embed-${member.username}`
    await openChannel(page, server.id, linksId)
    await sendMessage(page, url)
    const row = await linkMessage(member, linksId, url)
    expect(row.metadata?.suppress_embeds).toBe(true)

    await openChannel(page, server.id, linksId)
    const posted = rowOf(page, url)
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted.locator('a.url-link')).toHaveAttribute('href', url)
    await expect(posted.locator('.link-embed-card')).toHaveCount(0)

    const client = await userClient(member)
    const restore = await client.rpc('set_message_embeds_suppressed', { p_message_id: row.id, p_suppressed: false })
    expect(restore.error?.code).toBe('42501')
    expect(restore.error?.message).toBe('Missing permission: EMBED_LINKS')
  })

  await test.step('#emoji: the picker offers this server\'s emoji only, and it posts', async () => {
    await openChannel(page, server.id, emojiId)
    await openEmojiTab(page)
    await expect(picker(page).getByRole('note')).toHaveText(EXTERNAL_NOTICE)
    await expect(picker(page).locator('.section-title-collapsible', { hasText: server.name })).toBeVisible({ timeout: 15000 })
    await expect(picker(page).locator('.section-title-collapsible', { hasText: elsewhere.name })).toHaveCount(0)
    await expect(picker(page).getByRole('button', { name: `:${farEmoji.name}:` })).toHaveCount(0)
    await picker(page).getByRole('button', { name: `:${localEmoji.name}:` }).click()
    await expect(picker(page)).toHaveCount(0)
    await composer(page).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const posted = messageList(page).locator(`img[alt=":${localEmoji.name}:"]`).last()
    await expect(posted).toBeVisible({ timeout: 30000 })
  })

  await test.step('#emoji: another server\'s emoji is refused with a notice', async () => {
    await composer(page).click()
    await composer(page).pressSequentially(`:${farEmoji.name}: from elsewhere`, { delay: 10 })
    await page.keyboard.press('Escape')
    await composer(page).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(page.getByText(EXTERNAL_NOTICE)).toBeVisible({ timeout: 15000 })
    await expect(composer(page)).toContainText('from elsewhere')
    const { data } = await admin.from('messages').select('id').eq('channel_id', emojiId).eq('user_id', member.id)
    expect(data).toHaveLength(1)

    const client = await userClient(member)
    const refused = await client.from('reactions').insert({ message_id: reactTargetId, user_id: member.id, emoji_id: farEmoji.id })
    expect(refused.error?.code).toBe('42501')
    expect(refused.error?.message).toBe('Missing permission: USE_EXTERNAL_EMOJIS')
    const local = await client.from('reactions').insert({ message_id: reactTargetId, user_id: member.id, emoji_id: localEmoji.id })
    expect(local.error).toBeNull()
  })

  await test.step('#history: only messages sent since opening the channel show, and a note says why', async () => {
    await openChannel(page, server.id, historyId)
    await expect(messageList(page).getByTestId('history-restricted')).toContainText(HISTORY_NOTE, { timeout: 30000 })
    await expect.poll(() => viewStart(member, historyId), { timeout: 15000 }).not.toBeNull()
    await expect(rowOf(page, 'History from after you joined')).toHaveCount(0)
    await expect(rowOf(page, 'History from before you joined')).toHaveCount(0)

    const client = await userClient(member)
    const { data } = await client.from('messages').select('id').in('id', [beforeId, afterId])
    expect(data).toEqual([])
  })

  await test.step('#history: a message sent while it is open shows, until a reload starts a new view', async () => {
    const whileOpenId = await seedMessage(historyId, 'Sent while you were here')
    const client = await userClient(member)
    const { data } = await client.from('messages').select('id').eq('id', whileOpenId)
    expect(data).toEqual([{ id: whileOpenId }])
    // No realtime in the stack: the message loads when the member comes back to the channel.
    await channelItem(page, server.generalChannelId).click()
    await expect(page).toHaveURL(new RegExp(server.generalChannelId))
    await channelItem(page, historyId).click()
    await expect(rowOf(page, 'Sent while you were here')).toBeVisible({ timeout: 30000 })
    await expect(rowOf(page, 'History from after you joined')).toHaveCount(0)

    const firstView = await viewStart(member, historyId)
    await page.reload()
    await expect(messageList(page).getByTestId('history-restricted')).toContainText(HISTORY_NOTE, { timeout: 30000 })
    await expect.poll(() => viewStart(member, historyId), { timeout: 15000 }).not.toBe(firstView)
    await expect(rowOf(page, 'Sent while you were here')).toHaveCount(0)
    const after = await client.from('messages').select('id').eq('id', whileOpenId)
    expect(after.data).toEqual([])
  })
})

test('a role\'s channel Allow restores all three', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, trusted)

  await test.step('#links: the preview card shows', async () => {
    const url = `https://example.com/embed-${trusted.username}`
    await openChannel(page, server.id, linksId)
    await sendMessage(page, url)
    const row = await linkMessage(trusted, linksId, url)
    expect(row.metadata?.suppress_embeds).toBeUndefined()

    await openChannel(page, server.id, linksId)
    const posted = rowOf(page, url)
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted.locator('.link-embed-card')).toBeVisible({ timeout: 15000 })
  })

  await test.step('#emoji: the other server\'s emoji is offered and posts', async () => {
    await openChannel(page, server.id, emojiId)
    await openEmojiTab(page)
    await expect(picker(page).getByRole('note')).toHaveCount(0)
    await expect(picker(page).locator('.section-title-collapsible', { hasText: elsewhere.name })).toBeVisible({ timeout: 15000 })
    await picker(page).getByRole('button', { name: `:${farEmoji.name}:` }).click()
    await expect(picker(page)).toHaveCount(0)
    await composer(page).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(messageList(page).locator(`img[alt=":${farEmoji.name}:"]`).last()).toBeVisible({ timeout: 30000 })

    const client = await userClient(trusted)
    const reaction = await client.from('reactions').insert({ message_id: reactTargetId, user_id: trusted.id, emoji_id: farEmoji.id })
    expect(reaction.error).toBeNull()
  })

  await test.step('#history: the whole history reads, without the note', async () => {
    await openChannel(page, server.id, historyId)
    await expect(rowOf(page, 'History from after you joined')).toBeVisible({ timeout: 30000 })
    await expect(rowOf(page, 'History from before you joined')).toBeVisible()
    await expect(messageList(page).getByTestId('history-restricted')).toHaveCount(0)
    expect(await viewStart(trusted, historyId)).toBeNull()
  })
})
