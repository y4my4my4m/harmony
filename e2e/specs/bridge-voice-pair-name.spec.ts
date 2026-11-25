// Journey: a Discord bridge pair whose Harmony side is a voice channel (a Discord voice channel's
// chat) shows that channel's name on the Discord bridge page, not its id; the form for a new pair
// still offers text channels only (#215).
//
// The stack runs no bot gateway: the bridge and its pairs are written with the service role, as the
// gateway does.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, signIn, userClient, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let botId = ''
let loungeId = ''

const GUILD_ID = '900000000000000901'
const DISCORD_TEXT = '900000000000000902'
const DISCORD_VOICE = '900000000000000903'

test.beforeAll(async () => {
  owner = await createUser(admin, 'bvp')
  server = await seedServer(admin, owner, `Voice pairs ${owner.username}`)

  const { data: lounge, error: loungeError } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1 })
    .select('id')
    .single()
  if (loungeError || !lounge) throw new Error(`voice channel: ${loungeError?.message}`)
  loungeId = lounge.id

  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_bot', {
    p_username: `bridge${owner.username.slice(-8)}`,
    p_display_name: 'Discord Bridge',
    p_bio: 'Relays messages',
    p_bot_type: 'bridge',
    p_is_public: false,
  })
  if (error || !data?.bot?.id) throw new Error(`create_bot: ${error?.message}`)
  botId = data.bot.id
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)

  const channel = (id: string, name: string, type: number) =>
    ({ id, name, type, position: 0, can_view: true, can_send: true, can_manage_webhooks: true })
  const { data: bridge, error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({
      server_id: server.id,
      bot_id: botId,
      mode: 'self',
      discord_guild_id: GUILD_ID,
      discord_guild_name: 'Voice Guild',
      bridge_version: '2.8.0',
      created_by: owner.id,
      last_seen_at: new Date().toISOString(),
      snapshot: { guilds: [{ id: GUILD_ID, name: 'Voice Guild', channels: [channel(DISCORD_TEXT, 'general', 0), channel(DISCORD_VOICE, 'Lounge', 2)] }] },
    })
    .select('id')
    .single()
  if (bridgeError || !bridge) throw new Error(`bridge: ${bridgeError?.message}`)
  const { error: pairError } = await admin.from('discord_bridge_channels').insert([
    { bridge_id: bridge.id, harmony_channel_id: server.generalChannelId, discord_channel_id: DISCORD_TEXT, discord_channel_name: 'general', direction: 'both', created_by: owner.id },
    { bridge_id: bridge.id, harmony_channel_id: loungeId, discord_channel_id: DISCORD_VOICE, discord_channel_name: 'Lounge', direction: 'both', created_by: owner.id },
  ])
  if (pairError) throw new Error(`pairs: ${pairError.message}`)
})

test.afterAll(async () => {
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
})

test('a pair on a voice channel shows the channel name, and new pairs offer text channels only', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=discord-bridge`)

  const voicePair = page.locator(`[data-testid="pair-row"][data-harmony="${loungeId}"]`)
  await expect(voicePair).toBeVisible({ timeout: 45000 })
  await expect(voicePair.locator('.pair-name').first()).toHaveText('#lounge')
  await expect(voicePair).not.toContainText(loungeId)
  await expect(page.locator(`[data-testid="pair-row"][data-harmony="${server.generalChannelId}"] .pair-name`).first()).toHaveText('#general')

  const picker = page.getByTestId('select-harmony')
  await expect(picker.locator(`option[value="${loungeId}"]`)).toHaveCount(0)
})
