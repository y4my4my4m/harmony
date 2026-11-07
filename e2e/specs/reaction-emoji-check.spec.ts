// Journey: a reaction a client writes names an emoji, not a bare word
// (20261107800001_reaction_emoji_check). A member writing straight to PostgREST, as a modified
// client does, cannot store a bare name ("RIP", "6303_monkaSTEER") as a reaction: those
// rendered as text and federated with no Emoji tag. A unicode emoji, a server emoji of the
// server and joining a federated pill already on the message all work; the reaction bar shows
// no refused name.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let messageId: string
let serverEmojiId: string
let removedEmojiId: string
const marker = `react here ${Date.now().toString(36)}`
const IMAGE_URL = `${process.env.BASE_URL || 'http://localhost:5173'}/default_server.webp`

test.beforeAll(async () => {
  owner = await createUser(admin, 'rxco')
  member = await createUser(admin, 'rxcm')
  server = await seedServer(admin, owner, `Reactions ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)
  const { data: msg, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: marker }],
  }).select('id').single()
  if (error || !msg) throw new Error(`message: ${error?.message}`)
  messageId = msg.id
  const { data: srv, error: srvError } = await admin.from('emojis').insert({
    name: `rx${Date.now().toString(36)}`, url: IMAGE_URL, server_id: server.id, uploader: owner.id, scope: 'server',
  }).select('id').single()
  if (srvError || !srv) throw new Error(`server emoji: ${srvError?.message}`)
  serverEmojiId = srv.id
  const { data: own, error: ownError } = await admin.from('emojis').insert({
    name: `rxp${Date.now().toString(36)}`, url: IMAGE_URL, server_id: null, uploader: owner.id, scope: 'user',
  }).select('id').single()
  if (ownError || !own) throw new Error(`personal emoji: ${ownError?.message}`)
  removedEmojiId = own.id
  const { error: removeError } = await admin.from('emojis').update({ deleted_at: new Date().toISOString() }).eq('id', removedEmojiId)
  if (removeError) throw new Error(`remove emoji: ${removeError.message}`)
  // A federated pill, as the federation backend writes it (service role).
  const { error: pillError } = await admin.from('reactions').insert({
    message_id: messageId, user_id: owner.id, custom_emoji_content: ':blob@remote.example:', metadata: { federated: true },
  })
  if (pillError) throw new Error(`federated pill: ${pillError.message}`)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', [serverEmojiId, removedEmojiId].filter(Boolean))
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

test('a client reaction names a real emoji', async ({ page }) => {
  test.setTimeout(120_000)
  const client = await userClient(member)
  const react = (row: { emoji_id?: string; custom_emoji_content?: string }) =>
    client.from('reactions').insert({ message_id: messageId, user_id: member.id, ...row })

  await test.step('bare names are refused', async () => {
    for (const content of ['RIP', '6303_monkaSTEER', 'ananas']) {
      const { error } = await react({ custom_emoji_content: content })
      expect(error?.code, content).toBe('22023')
    }
  })

  await test.step('a removed emoji is refused', async () => {
    const { error } = await react({ emoji_id: removedEmojiId })
    expect(error?.code).toBe('22023')
  })

  await test.step('a unicode emoji, a server emoji and the federated pill are accepted', async () => {
    expect((await react({ custom_emoji_content: '🎉' })).error).toBeNull()
    expect((await react({ emoji_id: serverEmojiId })).error).toBeNull()
    expect((await react({ custom_emoji_content: ':blob@remote.example:' })).error).toBeNull()
  })

  await test.step('the stored reactions are exactly the accepted ones', async () => {
    const { data } = await admin.from('reactions').select('emoji_id, custom_emoji_content').eq('message_id', messageId).eq('user_id', member.id)
    expect((data ?? []).map((r) => r.emoji_id ?? r.custom_emoji_content).sort())
      .toEqual([':blob@remote.example:', '🎉', serverEmojiId].sort())
  })

  await test.step('the reaction bar shows no refused name', async () => {
    await signIn(page, member)
    await openChannel(page, server.id, server.generalChannelId)
    const row = messageList(page).getByRole('article').filter({ hasText: marker })
    await expect(row).toBeVisible({ timeout: 20000 })
    const bar = row.getByTestId('message-reactions')
    // 🎉, the server emoji, and the federated pill the member joined (count 2).
    await expect(bar.locator('.reaction')).toHaveCount(3, { timeout: 20000 })
    await expect(bar).not.toContainText('RIP')
    await expect(bar).not.toContainText('monkaSTEER')
  })
})

/** Hands a reaction_event payload to the page's subscription on `topic`, as broadcast_reaction_event sends it. */
async function deliverReaction(page: Page, topic: string, payload: Record<string, unknown>) {
  await page.evaluate(async ({ topic, payload }) => {
    const served = performance.getEntriesByType('resource').map((e) => e.name)
      .find((n) => n.includes('/src/services/RealtimeConnectionManager.ts'))
    const mod = await import(/* @vite-ignore */ served ?? '/src/services/RealtimeConnectionManager.ts')
    const sub = (mod.realtimeConnectionManager as any).subscriptions.get(topic)
    if (!sub) throw new Error(`no subscription on ${topic}`)
    const handler = sub.config.broadcasts.find((b: any) => b.event === 'reaction_event').handler
    await handler(payload)
  }, { topic, payload })
}

test('a bridged pill that arrives over realtime is joined by its identifier', async ({ page }) => {
  test.setTimeout(120_000)
  const snowflake = '923456789012345678'
  const identifier = `discord:pepe2:${snowflake}`
  const cdn = `https://cdn.discordapp.com/emojis/${snowflake}.png`
  const text = `bridged ${Date.now().toString(36)}`
  const { data: msg, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text }],
  }).select('id').single()
  if (error || !msg) throw new Error(`message: ${error?.message}`)
  await page.route('https://cdn.discordapp.com/**', (route) => route.fulfill({ path: 'public/default_server.webp', contentType: 'image/webp' }))

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  const row = messageList(page).getByRole('article').filter({ hasText: text })
  await expect(row).toBeVisible({ timeout: 20000 })

  // The bridge's row, written after the page loaded: the pill is built from the realtime event.
  const metadata = { remote_emoji_name: 'pepe2', remote_emoji_url: cdn, discord_user: { id: '41', username: 'dana' } }
  const { data: bridged, error: bridgeError } = await admin.from('reactions').insert({
    message_id: msg.id, user_id: owner.id, custom_emoji_content: identifier, metadata,
  }).select('id').single()
  if (bridgeError || !bridged) throw new Error(`bridged reaction: ${bridgeError?.message}`)
  await deliverReaction(page, `channel-messages-${server.generalChannelId}`, {
    type: 'reaction:insert', op: 'INSERT', reaction_id: bridged.id, message_id: msg.id, user_id: owner.id,
    emoji_id: null, custom_emoji_content: identifier, emoji_name: 'pepe2', emoji_url: cdn, metadata,
    username: owner.username, display_name: owner.displayName,
  })
  const pill = row.getByTestId('message-reactions').locator('.reaction')
  await expect(pill).toHaveCount(1, { timeout: 10000 })

  const sent = page.waitForRequest((r) => r.url().includes('/rest/v1/reactions') && r.method() === 'POST')
  await pill.click()
  const body = JSON.parse((await sent).postData() || '[]')
  expect((Array.isArray(body) ? body[0] : body).custom_emoji_content).toBe(identifier)

  await expect.poll(async () => {
    const { data } = await admin.from('reactions').select('custom_emoji_content').eq('message_id', msg.id).eq('user_id', member.id)
    return (data ?? []).map((r) => r.custom_emoji_content)
  }, { timeout: 15000 }).toEqual([identifier])
  await expect(pill).toHaveCount(1)
  await expect(pill.getByTestId('reaction-count')).toHaveText('2')
})
