// Journey: a Discord thread bridged into Harmony (Harmony 1.7.5, bridge 2.4.0). The bridge bot
// pairs the Discord thread with a Harmony thread on the member's bridged message
// (bot_create_thread, as the gateway calls it) and relays a Discord reply into it. The member
// sees the thread on their message, opens it and reads the reply under its Discord author.
//
// The stack runs no bot gateway: rows are written with the service role, as the gateway does.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let botId = ''
let threadId = ''

test.beforeAll(async () => {
  owner = await createUser(admin, 'brt')
  server = await seedServer(admin, owner, `Bridged ${owner.username}`)

  const { data: bot, error: botError } = await admin
    .from('bots')
    .insert({ username: `bridge_${owner.username}`.slice(0, 32), display_name: 'Discord Bridge', owner_id: owner.id, is_public: false, bot_type: 'bridge' })
    .select('id')
    .single()
  if (botError || !bot) throw new Error(`bot: ${botError?.message}`)
  botId = bot.id
  const { error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({ server_id: server.id, bot_id: botId, mode: 'self', discord_guild_id: '900000000000000777', created_by: owner.id })
  if (bridgeError) throw new Error(`bridge: ${bridgeError.message}`)

  const { data: starter, error: starterError } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: 'Weekend plans?' }] })
    .select('id')
    .single()
  if (starterError || !starter) throw new Error(`starter: ${starterError?.message}`)

  const { data: created, error: threadError } = await admin.rpc('bot_create_thread', {
    p_bot_id: botId,
    p_channel_id: server.generalChannelId,
    p_name: 'Weekend',
    p_parent_message_id: starter.id,
    p_discord_thread_id: '1400000000000000001',
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  threadId = created as string

  const { error: replyError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    thread_id: threadId,
    bot_id: botId,
    content: [{ type: 'text', text: 'Hiking on Saturday' }],
    metadata: {
      bot: true,
      bridge_source: 'discord',
      discord_message_id: '1400000000000000002',
      discord_user: { id: '1400000000000000003', username: 'dana', display_name: 'Dana' },
    },
  })
  if (replyError) throw new Error(`reply: ${replyError.message}`)
})

test.afterAll(async () => {
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  await deleteUser(admin, owner)
})

test('a Discord reply in a bridged thread reads in Harmony under its Discord author', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)

  const list = page.locator('[data-testid="message-list"]')
  await expect(list.getByText('Weekend plans?')).toBeVisible({ timeout: 30000 })
  // The thread reply stays out of the channel; the starter carries the thread.
  await expect(list.getByText('Hiking on Saturday')).toHaveCount(0)
  const view = list.getByRole('button', { name: /View Thread/ })
  await expect(view).toBeVisible({ timeout: 15000 })

  await view.click()
  const panel = page.getByRole('dialog', { name: 'Weekend' })
  await expect(panel).toBeVisible({ timeout: 15000 })
  await expect(panel.getByText('Hiking on Saturday')).toBeVisible({ timeout: 15000 })
  await expect(panel.getByText('Dana').first()).toBeVisible()

  const { data: pair } = await admin.from('discord_bridge_threads').select('discord_thread_id').eq('thread_id', threadId).single()
  expect(pair?.discord_thread_id).toBe('1400000000000000001')
})
