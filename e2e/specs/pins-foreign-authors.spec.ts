// Journey: the pinned list names authors that have no Harmony profile as chat does: a bridged
// Discord person by metadata.discord_user, a channel webhook by metadata.webhook, a bot by its
// own name. None reads "Unknown", and a bot does not read "Bot".
//
// The stack runs no bot gateway: rows are written with the service role, as the gateway and
// execute_channel_webhook write them.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const botIds: string[] = []

async function seedBot(username: string, displayName: string, botType: 'bot' | 'bridge'): Promise<string> {
  const { data, error } = await admin
    .from('bots')
    .insert({ username: username.slice(0, 32), display_name: displayName, owner_id: owner.id, is_public: false, bot_type: botType })
    .select('id')
    .single()
  if (error || !data) throw new Error(`bot ${displayName}: ${error?.message}`)
  botIds.push(data.id)
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: data.id, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install ${displayName}: ${installError.message}`)
  return data.id
}

async function seedPin(botId: string, text: string, metadata: Record<string, unknown>, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    bot_id: botId,
    content: [{ type: 'text', text }],
    metadata,
    created_at: at,
    is_pinned: true,
    pinned_at: at,
    pinned_by: owner.id,
  })
  if (error) throw new Error(`pin "${text}": ${error.message}`)
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'pfa')
  server = await seedServer(admin, owner, `Pins ${owner.username}`)
  const bridgeBot = await seedBot(`bridge_${owner.username}`, 'Discord Bridge', 'bridge')
  const plainBot = await seedBot(`deploy_${owner.username}`, 'Deploy Bot', 'bot')

  await seedPin(bridgeBot, 'bridged pin from Discord', {
    bot: true,
    bridge_source: 'discord',
    discord_message_id: '1500000000000000001',
    discord_user: { id: '1500000000000000002', username: 'gus', display_name: 'Gus' },
  }, 3)
  await seedPin(bridgeBot, 'webhook pin from CI', {
    webhook: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Deploys', avatar_url: null },
  }, 2)
  await seedPin(plainBot, 'bot pin from the deploy bot', { bot: true }, 1)
})

test.afterAll(async () => {
  if (botIds.length) await admin.from('bots').delete().in('id', botIds)
  await deleteUser(admin, owner)
})

test('the pinned list names bridged, webhook and bot authors as chat does', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(messageList(page).getByText('bot pin from the deploy bot')).toBeVisible({ timeout: 30000 })

  await page.locator('.chat-header').getByRole('button', { name: '3 pinned messages' }).click()
  const pins = page.getByRole('dialog', { name: 'Pinned messages' })
  await expect(pins).toBeVisible({ timeout: 10000 })
  const items = pins.locator('.pinned-message-item')
  await expect(items).toHaveCount(3)

  const authorOf = (text: string) => items.filter({ hasText: text }).locator('.message-author')
  await expect(authorOf('bridged pin from Discord')).toHaveText('Gus')
  await expect(authorOf('webhook pin from CI')).toHaveText('Deploys')
  await expect(authorOf('bot pin from the deploy bot')).toHaveText('Deploy Bot', { timeout: 10000 })
  await expect(pins.locator('.message-author').filter({ hasText: /Unknown/ })).toHaveCount(0)
})
