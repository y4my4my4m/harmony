// Journey: My bots names the servers each bot is installed in, including a private server
// of someone else's the owner is not a member of (a bridge bot set up by another member is
// one). The bot page lists them all; the card names two and counts the rest. A connected
// bot reads Online rather than when it last connected.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  userClient,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let other: SpecUser
let botName = ''

test.beforeAll(async () => {
  owner = await createUser(admin, 'mbs')
  other = await createUser(admin, 'mbso')
  const own = await seedServer(admin, owner, `Own Lab ${owner.username}`)
  const hidden = await seedServer(admin, other, `Hidden Hall ${owner.username}`)
  const extra = await seedServer(admin, other, `Zed Room ${owner.username}`)

  botName = `Relay ${owner.username.slice(-5)}`
  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_bot', {
    p_username: `relay${owner.username.slice(-8)}`,
    p_display_name: botName,
    p_bio: 'Relays messages',
    p_bot_type: 'bot',
    p_is_public: false,
  })
  if (error || !data?.bot?.id) throw new Error(`create_bot: ${error?.message}`)
  const botId = data.bot.id as string

  const installs = [
    { server_id: own.id, installed_by: owner.id },
    { server_id: hidden.id, installed_by: other.id },
    { server_id: extra.id, installed_by: other.id },
  ].map((row) => ({ ...row, bot_id: botId, is_active: true }))
  const { error: installError } = await admin.from('bot_server_permissions').insert(installs)
  if (installError) throw new Error(`install: ${installError.message}`)

  const now = new Date().toISOString()
  await admin.from('bots').update({ last_online_at: now }).eq('id', botId)
  const { error: presenceError } = await admin.from('bot_presence').upsert(
    { bot_id: botId, status: 'online', connected_at: now, last_heartbeat_at: now, gateway_session_id: 'e2e' },
    { onConflict: 'bot_id' },
  )
  if (presenceError) throw new Error(`presence: ${presenceError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, other)
})

test('My bots names the servers a bot is in', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto('/settings/bots')
  await dismissAnnouncements(page)

  const card = page.locator('.bot-row').filter({ hasText: botName })
  await expect(card).toBeVisible({ timeout: 30000 })
  const servers = card.locator('.bot-servers')
  await expect(servers).toHaveText(`In Hidden Hall ${owner.username}, Own Lab ${owner.username} and 1 more`)
  await expect(servers).toHaveAttribute(
    'title',
    `Hidden Hall ${owner.username}, Own Lab ${owner.username}, Zed Room ${owner.username}`,
  )

  await expect(card.locator('.bot-meta')).toContainText('Online')
  await expect(card.locator('.bot-meta')).not.toContainText('Last connected')

  await card.click()
  await expect(page.getByText(`Zed Room ${owner.username}`, { exact: false }).first()).toBeVisible({ timeout: 15000 })
})
