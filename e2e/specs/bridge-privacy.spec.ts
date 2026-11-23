// Journey: bridge privacy (Harmony 1.9.7, bridge 2.6.0). A bridge has relayed messages of two
// Discord authors into a channel. The test acts as the bridge, over the bot gateway with the
// bridge bot's token, for what a Discord member does with /bridge-privacy, and as the server's
// manager in Server settings, Discord Bridge, Bridge privacy.
//
// - Dana opts out on Discord: her next message is refused, Eve's still crosses. The links of her
//   kept messages are still re-signed; their words cannot change.
// - Dana erases: her messages leave the channel; Eve's and the manager's own stay.
// - The manager removes Eve by Discord ID: her messages leave, she is listed as removed by a
//   manager, her next message is refused, and Restore lets her through again.
// - Remove all bridged messages leaves only what was written on Harmony.
//
// Harmony 1.9.8: an outsider's message naming Dana meets the reserved-key refusal, which tells
// nothing of her opt-out; the bridge cannot move a message onto her or off her. A thread Eve
// starts on a message of Dana's arrives as Thread, as does a thread on an AutoMod alert about
// Dana once she erases, and a thread Eve started before her Restore.
//
// The bridge registers both members with op 6 and keeps them registered, as a bridge older than
// 2.6.0 does: the member list drops whoever is left out all the same, and a mention of her arrives
// as text. A reply to an erased message crosses without the reply.
//
// The stack runs the bot gateway as a child process (see botGateway.ts).

import { test, expect } from '@playwright/test'
import WebSocket from 'ws'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'

const admin = adminClient()
let owner: SpecUser
let outsider: SpecUser
let server: SeededServer
let botId = ''
let token = ''
let gateway: BotGateway
let ownerJwt = ''
let socket: WebSocket | null = null

const GUILD_ID = '900000000000000889'
const DISCORD_CHANNEL_ID = '1500000000000000100'
const DANA = { id: '1500000000000000101', username: 'dana', display_name: 'Dana' }
const EVE = { id: '1500000000000000102', username: 'eve', display_name: 'Eve' }
let nextDiscordId = 1500000000000000200n

test.beforeAll(async () => {
  owner = await createUser(admin, 'bpo')
  outsider = await createUser(admin, 'bpx')
  server = await seedServer(admin, owner, `Privacy ${owner.username}`)

  const client = await userClient(owner)
  ownerJwt = (await client.auth.getSession()).data.session!.access_token
  const { data, error } = await client.rpc('create_bot', {
    p_username: `bridge${owner.username.slice(-8)}`,
    p_display_name: 'Discord Bridge',
    p_bio: 'Relays messages',
    p_bot_type: 'bridge',
    p_is_public: false,
  })
  if (error || !data?.bot?.id || !data?.token) throw new Error(`create_bot: ${error?.message}`)
  botId = data.bot.id
  token = data.token
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)

  const { data: bridge, error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({
      server_id: server.id,
      bot_id: botId,
      mode: 'self',
      discord_guild_id: GUILD_ID,
      discord_guild_name: 'Privacy Guild',
      bridge_version: '2.6.0',
      created_by: owner.id,
      last_seen_at: new Date().toISOString(),
      snapshot: {
        guilds: [{
          id: GUILD_ID,
          name: 'Privacy Guild',
          channels: [{ id: DISCORD_CHANNEL_ID, name: 'general', type: 0, position: 0, can_view: true, can_send: true, can_manage_webhooks: true }],
        }],
      },
    })
    .select('id')
    .single()
  if (bridgeError || !bridge) throw new Error(`bridge: ${bridgeError?.message}`)
  const { error: pairError } = await admin.from('discord_bridge_channels').insert({
    bridge_id: bridge.id,
    harmony_channel_id: server.generalChannelId,
    discord_channel_id: DISCORD_CHANNEL_ID,
    discord_channel_name: 'general',
    direction: 'both',
    created_by: owner.id,
  })
  if (pairError) throw new Error(`pair: ${pairError.message}`)

  const { error: ownError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text: 'Written on Harmony' }],
  })
  if (ownError) throw new Error(`own message: ${ownError.message}`)

  gateway = await startBotGateway()
})

test.afterAll(async () => {
  socket?.close()
  await gateway?.stop()
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
  await deleteUser(admin, outsider)
})

async function gatewayCall(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${gateway.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json: json as Record<string, any> | null, text }
}

/** A live relayed message of a Discord author, as the bridge posts it. */
function relay(author: typeof DANA, text: string, replyTo?: string, files: unknown[] = []) {
  nextDiscordId += 1n
  return gatewayCall(`/api/v1/channels/${server.generalChannelId}/messages`, {
    method: 'POST',
    body: {
      content: [{ type: 'text', text }, ...files],
      ...(replyTo ? { reply_to: replyTo } : {}),
      metadata: { discord_user: author, discord_message_id: String(nextDiscordId), bridge_source: 'discord' },
    },
  })
}

/** A Discord thread as the bridge creates it on Harmony; answers the thread object. */
function bridgeThread(body: Record<string, unknown>) {
  nextDiscordId += 1n
  return gatewayCall(`/api/v1/channels/${server.generalChannelId}/threads`, {
    method: 'POST',
    body: { discord_thread_id: String(nextDiscordId), ...body },
  })
}

/** Identifies as the bridge and registers both Discord members of #general (op 6). */
async function registerMembers(): Promise<void> {
  socket = new WebSocket(gateway.wsUrl)
  await new Promise((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
  const ready = new Promise<void>((resolve) => {
    socket!.on('message', (raw) => { if (JSON.parse(raw.toString()).t === 'READY') resolve() })
  })
  socket.send(JSON.stringify({ op: 2, d: { token } }))
  await ready
  const members = [DANA, EVE].map((u) => ({
    id: u.id, username: u.username, displayName: u.display_name, avatarUrl: '', source: 'discord', presenceStatus: 'online',
  }))
  socket.send(JSON.stringify({ op: 6, d: { channels: [{ harmonyChannelId: server.generalChannelId, members }] } }))
}

/** Discord ids the gateway serves the owner for #general. */
async function bridgedIds(): Promise<string[]> {
  const res = await fetch(`${gateway.url}/bridged-users/${server.generalChannelId}`, {
    headers: { Authorization: `Bearer ${ownerJwt}` },
  })
  expect(res.status).toBe(200)
  return ((await res.json()).users as Array<{ id: string }>).map((u) => u.id).sort()
}

/** Texts of the channel's messages that name a relayed author, as stored; thread notices left out. */
async function relayedTexts(): Promise<string[]> {
  const { data, error } = await admin
    .from('messages')
    .select('content, metadata, created_at')
    .eq('channel_id', server.generalChannelId)
    .not('metadata->discord_user', 'is', null)
    .not('is_system', 'is', true)
    .order('created_at')
  if (error) throw new Error(`messages: ${error.message}`)
  return (data ?? []).map((row) => (row.content as Array<{ text?: string }>)[0]?.text ?? '')
}

test('a Discord member opts out and erases; a manager removes another and clears the rest', async ({ page }) => {
  test.setTimeout(300_000)

  const sentIds: string[] = []
  const photo = { type: 'file', fileType: 'image', url: 'https://cdn.discordapp.com/attachments/1500000000000000100/1500000000000000300/photo.png?ex=1', name: 'photo.png' }
  for (const [author, text] of [[DANA, 'Dana one'], [EVE, 'Eve one'], [DANA, 'Dana two'], [EVE, 'Eve two']] as const) {
    const sent = await relay(author, text, undefined, text === 'Dana two' ? [photo] : [])
    expect(sent.status, sent.text).toBe(201)
    sentIds.push(sent.json?.id)
  }
  const danaOneId = sentIds[0]
  await registerMembers()
  await expect.poll(bridgedIds, { timeout: 15000 }).toEqual([DANA.id, EVE.id].sort())
  const versionBefore = (await gatewayCall('/bridge/v2/config')).json?.privacy_version
  expect(typeof versionBefore).toBe('string')

  // The app reads the members from this spec's gateway.
  await page.route('**/bot-gateway/bridged-users/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/bot-gateway/, '')
    await route.fulfill({ response: await route.fetch({ url: `${gateway.url}${path}` }) })
  })
  await signIn(page, owner)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  const list = page.locator('[data-testid="message-list"]')
  await expect(list.getByText('Dana two')).toBeVisible({ timeout: 45000 })
  await expect(list.getByText('Eve two')).toBeVisible()
  const discordMember = (name: string) => page.locator('.user-sidebar .user-item.bridged-user').filter({ hasText: name })
  await expect(discordMember('Dana')).toBeVisible({ timeout: 20000 })
  await expect(discordMember('Eve')).toBeVisible()

  await test.step('Dana opts out on Discord: her next message is refused, Eve still crosses', async () => {
    expect((await gatewayCall(`/bridge/v2/privacy/optouts/${DANA.id}`)).json?.opted_out).toBe(false)
    const out = await gatewayCall(`/bridge/v2/privacy/optouts/${DANA.id}`, { method: 'PUT', body: {} })
    expect(out.status, out.text).toBe(200)
    expect(out.json).toMatchObject({ opted_out: true, source: 'self' })

    const listed = await gatewayCall('/bridge/v2/privacy/optouts')
    expect(listed.json?.remote_user_ids).toEqual([DANA.id])
    const config = await gatewayCall('/bridge/v2/config')
    expect(config.json?.privacy_version).not.toBe(versionBefore)
    expect(config.json?.privacy_version).toBe(listed.json?.version)

    const refused = await relay(DANA, 'Dana after opting out')
    expect(refused.status, refused.text).toBe(403)
    expect(refused.json?.code).toBe('BRIDGE_AUTHOR_OPTED_OUT')
    expect((await relay(EVE, 'Eve three')).status).toBe(201)

    // The bridge still re-signs the links of what she left on Harmony; it cannot change her words.
    const keptId = sentIds[2]
    const { data: kept } = await admin.from('messages').select('content').eq('id', keptId).single()
    const resigned = (kept!.content as Array<Record<string, any>>)
      .map((p) => (p.type === 'file' ? { ...p, url: `${String(p.url).split('?')[0]}?ex=2` } : p))
    const refresh = await gatewayCall(`/api/v1/messages/${keptId}/content-silent`, { method: 'PATCH', body: { content: resigned } })
    expect(refresh.status, refresh.text).toBe(200)
    const reworded = resigned.map((p) => (p.type === 'text' ? { ...p, text: 'Words Dana never wrote' } : p))
    const rewrite = await gatewayCall(`/api/v1/messages/${keptId}/content-silent`, { method: 'PATCH', body: { content: reworded } })
    expect(rewrite.status).toBe(400)
    expect(rewrite.json?.error).toBe('BRIDGE_AUTHOR_OPTED_OUT')
    // Opting out alone removes nothing.
    expect(await relayedTexts()).toEqual(['Dana one', 'Eve one', 'Dana two', 'Eve two', 'Eve three'])
  })

  await test.step('her opt-out stays the bridge\'s and the manager\'s to know, and her words stay off', async () => {
    // Any account's message naming a Discord user is refused for the key, opted out or not.
    const probe = await userClient(outsider)
    for (const id of [DANA.id, EVE.id]) {
      const { error } = await probe.from('messages').insert({
        channel_id: server.generalChannelId, user_id: outsider.id,
        content: [{ type: 'text', text: 'probe' }], metadata: { discord_user: { id } },
      })
      expect(error?.message).toBe('metadata key reserved for the server: discord_user')
    }

    // The bridge moves no message onto her, nor one of hers to someone else.
    const onto = await gatewayCall(`/api/v1/messages/${sentIds[1]}/metadata`, { method: 'PATCH', body: { metadata: { discord_user: DANA } } })
    expect(onto.status, onto.text).toBe(403)
    expect(onto.json?.code).toBe('BRIDGE_AUTHOR_OPTED_OUT')
    const off = await gatewayCall(`/api/v1/messages/${sentIds[2]}/metadata`, { method: 'PATCH', body: { metadata: { discord_user: EVE } } })
    expect(off.status, off.text).toBe(403)
    const { data: kept } = await admin.from('messages').select('metadata').eq('id', sentIds[2]).single()
    expect(kept?.metadata?.discord_user?.id).toBe(DANA.id)

    // Someone starts a Discord thread on a message of Dana's, which Discord titles with her words.
    const onDana = await bridgeThread({
      name: 'Dana after opting out', starter_discord_user_id: DANA.id, created_at: new Date().toISOString(),
    })
    expect(onDana.status, onDana.text).toBe(201)
    expect(onDana.json?.name).toBe('Thread')
    const { data: notice } = await admin.from('messages').select('metadata')
      .eq('channel_id', server.generalChannelId).eq('metadata->>thread_id', onDana.json?.id).single()
    expect(notice?.metadata?.thread_name).toBe('Thread')
  })

  // AutoMod blocked one of Dana's messages; a moderator's bot started a thread on the alert,
  // titled from it.
  const { data: event, error: eventError } = await admin.from('automod_events').insert({
    server_id: server.id, channel_id: server.generalChannelId, bot_id: botId, event_type: 'message',
    details: { author_key: `discord:${DANA.id}`, author_name: 'dana' },
  }).select('id').single()
  expect(eventError).toBeNull()
  const alertText = 'Blocked a message from @dana (Discord): secret plans'
  const { data: alert, error: alertError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, is_system: true, content: [{ type: 'text', text: alertText }],
    metadata: { type: 'automod_alert', automod: { event_id: event!.id } },
  }).select('id').single()
  expect(alertError).toBeNull()
  const onAlert = await gatewayCall(`/api/v1/channels/${server.generalChannelId}/threads`, {
    method: 'POST', body: { name: alertText, message_id: alert!.id },
  })
  expect(onAlert.status, onAlert.text).toBe(201)
  expect(onAlert.json?.name).toBe(alertText)

  await test.step('Dana erases: her messages leave the channel, the others stay', async () => {
    const erased = await gatewayCall('/bridge/v2/privacy/erase', { method: 'POST', body: { remote_user_id: DANA.id } })
    expect(erased.status, erased.text).toBe(202)
    expect(erased.json).toEqual({ opted_out: true, erased: 2, more: false })
    const again = await gatewayCall('/bridge/v2/privacy/erase', { method: 'POST', body: { remote_user_id: DANA.id } })
    expect(again.status).toBe(429)
    expect(again.json?.code).toBe('erase_recent')

    expect(await relayedTexts()).toEqual(['Eve one', 'Eve two', 'Eve three'])
    // The alert stays under its thread, emptied; the thread and its notice lose the alert's words.
    const { data: alertThread } = await admin.from('threads').select('name').eq('id', onAlert.json?.id).single()
    expect(alertThread?.name).toBe('Thread')
    await page.reload()
    await dismissAnnouncements(page)
    await expect(list.getByText('Eve three')).toBeVisible({ timeout: 45000 })
    await expect(list.getByText('secret plans')).toHaveCount(0)
    await expect(list.getByText('Dana after opting out')).toHaveCount(0)
    await expect(list.getByText('Written on Harmony')).toBeVisible()
    await expect(list.getByText('Dana one')).toHaveCount(0)
    await expect(list.getByText('Dana two')).toHaveCount(0)
    // The bridge still registers her; the member list leaves her out.
    await expect(discordMember('Eve')).toBeVisible({ timeout: 20000 })
    await expect(discordMember('Dana')).toHaveCount(0)
  })

  await page.goto(`/server/${server.id}?section=discord-bridge`)
  const panel = page.locator('[data-testid="bridge-privacy"]')
  await expect(panel).toBeVisible({ timeout: 45000 })
  const rowOf = (id: string) => panel.locator('[data-testid="privacy-row"]').filter({ hasText: id })

  await test.step('the manager sees Dana left out by her own choice, with nothing to restore', async () => {
    await expect(rowOf(DANA.id)).toContainText('Opted out on Discord', { timeout: 20000 })
    await expect(rowOf(DANA.id).locator('[data-testid="privacy-restore"]')).toHaveCount(0)
  })

  await test.step('the manager removes Eve by Discord ID', async () => {
    await panel.locator('[data-testid="privacy-id"]').fill('eve')
    await panel.locator('[data-testid="privacy-remove"]').click()
    await expect(panel.locator('[data-testid="privacy-id-help"]')).toHaveText('A Discord user ID is 5 to 20 digits.')
    await expect(panel.locator('[data-testid="privacy-remove-confirm"]')).toHaveCount(0)

    await panel.locator('[data-testid="privacy-id"]').fill(EVE.id)
    await panel.locator('[data-testid="privacy-remove"]').click()
    await expect(panel.locator('[data-testid="privacy-remove-confirm"]')).toContainText(EVE.id)
    expect(await relayedTexts()).toEqual(['Eve one', 'Eve two', 'Eve three'])
    await panel.locator('[data-testid="privacy-confirm-yes"]').click()
    await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Removed 3 messages' }))
      .toBeVisible({ timeout: 30000 })

    expect(await relayedTexts()).toEqual([])
    await expect(rowOf(EVE.id)).toContainText('Removed by a manager')
    expect(await bridgedIds()).toEqual([])
    const refused = await relay(EVE, 'Eve after removal')
    expect(refused.status, refused.text).toBe(403)
    // Her own opt-in does not lift a manager's removal.
    const optIn = await gatewayCall(`/bridge/v2/privacy/optouts/${EVE.id}`, { method: 'DELETE' })
    expect(optIn.json).toMatchObject({ opted_out: true, source: 'manager' })
  })

  await test.step('Restore lets Eve through again', async () => {
    await rowOf(EVE.id).locator('[data-testid="privacy-restore"]').click()
    await expect(rowOf(EVE.id)).toHaveCount(0, { timeout: 20000 })
    await expect(rowOf(DANA.id)).toHaveCount(1)
    expect(await bridgedIds()).toEqual([EVE.id])
    // Her first message answers one of Dana's, erased since: it crosses without the reply.
    const back = await relay(EVE, 'Eve is back', danaOneId)
    expect(back.status, back.text).toBe(201)
    const { data: stored } = await admin.from('messages').select('reply_to').eq('id', back.json?.id).single()
    expect(stored?.reply_to).toBeNull()
    // A mention of Dana, still opted out, arrives as text, whatever the bridge sent.
    const danaMention = { type: 'mention', userId: DANA.id, username: DANA.username, domain: 'discord.com', isLocal: false,
      displayName: DANA.display_name, isBridged: true, bridgeSource: 'discord' }
    const again = await relay(EVE, 'Eve again', undefined, [danaMention])
    expect(again.status, again.text).toBe(201)
    const { data: mentioning } = await admin.from('messages').select('content').eq('id', again.json?.id).single()
    expect((mentioning?.content as unknown[])[1]).toEqual({ type: 'text', text: '@Dana' })

    // A Discord thread Eve started while removed reaches Harmony with its first post now: it
    // arrives as Thread, without her name. One she starts now keeps its title.
    const before = await bridgeThread({ name: 'Eve while removed', discord_user: EVE, created_at: new Date(Date.now() - 3_600_000).toISOString() })
    expect(before.status, before.text).toBe(201)
    expect(before.json?.name).toBe('Thread')
    const after = await bridgeThread({ name: 'Eve is back thread', discord_user: EVE, created_at: new Date(Date.now() + 60_000).toISOString() })
    expect(after.json?.name).toBe('Eve is back thread')

    const chat = await page.context().newPage()
    await chat.route('**/bot-gateway/bridged-users/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/bot-gateway/, '')
      await route.fulfill({ response: await route.fetch({ url: `${gateway.url}${path}` }) })
    })
    await chat.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(chat)
    const chatList = chat.locator('[data-testid="message-list"]')
    const notice = (name: string) => chatList.locator('.thread-created-text').filter({ hasText: name })
    await expect(notice('Eve is back thread')).toContainText('Eve started a thread', { timeout: 45000 })
    await expect(chatList.getByText('Eve while removed')).toHaveCount(0)
    await chat.close()
    // The purge below counts the bridged messages it removes; these notices would be among them.
    const { error: cleanup } = await admin.from('messages').delete().in('metadata->>thread_id', [before.json?.id, after.json?.id])
    expect(cleanup).toBeNull()
  })

  await test.step('Remove all bridged messages leaves what was written on Harmony', async () => {
    await panel.locator('[data-testid="privacy-purge"]').click()
    await expect(panel.locator('[data-testid="privacy-purge-confirm"]')).toContainText('cannot be undone')
    expect(await relayedTexts()).toEqual(['Eve is back', 'Eve again'])
    await panel.locator('[data-testid="privacy-confirm-yes"]').click()
    await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Removed 2 bridged messages' }))
      .toBeVisible({ timeout: 30000 })
    expect(await relayedTexts()).toEqual([])

    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(list.getByText('Written on Harmony')).toBeVisible({ timeout: 45000 })
    await expect(list.getByText('Eve is back')).toHaveCount(0)
    // Dana's opt-out outlives the purge.
    expect((await gatewayCall('/bridge/v2/privacy/optouts')).json?.remote_user_ids).toEqual([DANA.id])
  })
})
