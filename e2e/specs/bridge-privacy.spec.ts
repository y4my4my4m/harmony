// Journey: bridge privacy (Harmony 1.9.7, bridge 2.6.0). A bridge has relayed messages of two
// Discord authors into a channel. The test acts as the bridge, over the bot gateway with the
// bridge bot's token, for what a Discord member does with /bridge-privacy, and as the server's
// manager in Server settings, Discord Bridge, Bridge privacy.
//
// - Dana opts out on Discord: her next message is refused, Eve's still crosses.
// - Dana erases: her messages leave the channel; Eve's and the manager's own stay.
// - The manager removes Eve by Discord ID: her messages leave, she is listed as removed by a
//   manager, her next message is refused, and Restore lets her through again.
// - Remove all bridged messages leaves only what was written on Harmony.
//
// The stack runs the bot gateway as a child process (see botGateway.ts).

import { test, expect } from '@playwright/test'
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
let server: SeededServer
let botId = ''
let token = ''
let gateway: BotGateway

const GUILD_ID = '900000000000000889'
const DISCORD_CHANNEL_ID = '1500000000000000100'
const DANA = { id: '1500000000000000101', username: 'dana', display_name: 'Dana' }
const EVE = { id: '1500000000000000102', username: 'eve', display_name: 'Eve' }
let nextDiscordId = 1500000000000000200n

test.beforeAll(async () => {
  owner = await createUser(admin, 'bpo')
  server = await seedServer(admin, owner, `Privacy ${owner.username}`)

  const client = await userClient(owner)
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
  await gateway?.stop()
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
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
function relay(author: typeof DANA, text: string) {
  nextDiscordId += 1n
  return gatewayCall(`/api/v1/channels/${server.generalChannelId}/messages`, {
    method: 'POST',
    body: {
      content: [{ type: 'text', text }],
      metadata: { discord_user: author, discord_message_id: String(nextDiscordId), bridge_source: 'discord' },
    },
  })
}

/** Texts of the channel's messages that name a relayed author, as stored. */
async function relayedTexts(): Promise<string[]> {
  const { data, error } = await admin
    .from('messages')
    .select('content, metadata, created_at')
    .eq('channel_id', server.generalChannelId)
    .not('metadata->discord_user', 'is', null)
    .order('created_at')
  if (error) throw new Error(`messages: ${error.message}`)
  return (data ?? []).map((row) => (row.content as Array<{ text?: string }>)[0]?.text ?? '')
}

test('a Discord member opts out and erases; a manager removes another and clears the rest', async ({ page }) => {
  test.setTimeout(300_000)

  for (const [author, text] of [[DANA, 'Dana one'], [EVE, 'Eve one'], [DANA, 'Dana two'], [EVE, 'Eve two']] as const) {
    const sent = await relay(author, text)
    expect(sent.status, sent.text).toBe(201)
  }
  const versionBefore = (await gatewayCall('/bridge/v2/config')).json?.privacy_version
  expect(typeof versionBefore).toBe('string')

  await signIn(page, owner)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  const list = page.locator('[data-testid="message-list"]')
  await expect(list.getByText('Dana two')).toBeVisible({ timeout: 45000 })
  await expect(list.getByText('Eve two')).toBeVisible()

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
    // Opting out alone removes nothing.
    expect(await relayedTexts()).toEqual(['Dana one', 'Eve one', 'Dana two', 'Eve two', 'Eve three'])
  })

  await test.step('Dana erases: her messages leave the channel, the others stay', async () => {
    const erased = await gatewayCall('/bridge/v2/privacy/erase', { method: 'POST', body: { remote_user_id: DANA.id } })
    expect(erased.status, erased.text).toBe(202)
    expect(erased.json).toEqual({ opted_out: true, erased: 2, more: false })
    const again = await gatewayCall('/bridge/v2/privacy/erase', { method: 'POST', body: { remote_user_id: DANA.id } })
    expect(again.status).toBe(429)
    expect(again.json?.code).toBe('erase_recent')

    expect(await relayedTexts()).toEqual(['Eve one', 'Eve two', 'Eve three'])
    await page.reload()
    await dismissAnnouncements(page)
    await expect(list.getByText('Eve three')).toBeVisible({ timeout: 45000 })
    await expect(list.getByText('Written on Harmony')).toBeVisible()
    await expect(list.getByText('Dana one')).toHaveCount(0)
    await expect(list.getByText('Dana two')).toHaveCount(0)
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
    expect((await relay(EVE, 'Eve is back')).status).toBe(201)
    expect((await relay(EVE, 'Eve again')).status).toBe(201)
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
