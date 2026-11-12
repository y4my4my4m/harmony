// Journey: importing Discord history through the bridge (Harmony 1.9.x, bridge 2.6.0). A server
// manager opens Discord Bridge settings and clicks "Import history" on a pair. The test then acts
// as the bridge, over the bot gateway's Bridge v2 routes with the bridge bot's token: it sets the
// job running, posts a batch of two messages dated 2023 (one mentioning another member), and sets
// the job done.
//
// The channel then reads the old messages in date order above the existing one, under their
// Discord authors' names, the mentioned member has no notification and no new unread count, and
// the pair reads "Imported 2 messages".
//
// Import is off on a new instance. The first journey finds it off for the manager and for the
// bridge, an instance admin turns it on in Admin, Config, and the manager then has the button. The
// second starts an import through the confirmation. A batch with a future-dated message and one
// by an opted-out author stores neither, and a batch past the instance's rate is told to wait.
//
// The stack runs the bot gateway as a child process (see botGateway.ts). The bridge itself is the
// test: it holds the bot token and calls the routes the real bridge calls.
//
// The three instance_config keys the journeys write are restored afterwards.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addMember,
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
let member: SpecUser
let staff: SpecUser
let server: SeededServer
let botId = ''
let token = ''
let gateway: BotGateway

const GUILD_ID = '900000000000000888'
const DISCORD_CHANNEL_ID = '1400000000000000100'
const ALICE = { id: '1400000000000000101', username: 'alice', display_name: 'Alice' }
const BOB = { id: '1400000000000000102', username: 'bob', display_name: 'Bob' }
const CAROL = { id: '1400000000000000103', username: 'carol', display_name: 'Carol' }

const CONFIG_KEYS = ['bridge_history_import', 'bridge_import_max_running', 'bridge_import_messages_per_minute']
let configBefore: Array<{ config_key: string; config_value: unknown }> = []

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function readConfig(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  return data?.config_value
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const { data: stored, error: storedError } = await admin
    .from('instance_config').select('config_key, config_value').in('config_key', CONFIG_KEYS)
  if (storedError) throw new Error(`instance_config: ${storedError.message}`)
  configBefore = stored ?? []
  await setConfig('bridge_history_import', 'off')
  await setConfig('bridge_import_max_running', 1)
  await setConfig('bridge_import_messages_per_minute', 600)

  owner = await createUser(admin, 'bhi')
  member = await createUser(admin, 'bhm')
  staff = await createUser(admin, 'bhs')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(`promote: ${promoteError.message}`)
  server = await seedServer(admin, owner, `Import ${owner.username}`)
  await addMember(admin, member, server.id)

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

  // A bridge that reports 2.6.0, with the Discord channel in its snapshot, paired both ways.
  const { data: bridge, error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({
      server_id: server.id,
      bot_id: botId,
      mode: 'self',
      discord_guild_id: GUILD_ID,
      discord_guild_name: 'Old Guild',
      bridge_version: '2.6.0',
      created_by: owner.id,
      last_seen_at: new Date().toISOString(),
      snapshot: {
        guilds: [{
          id: GUILD_ID,
          name: 'Old Guild',
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

  // An existing message, posted by the owner as the channel's latest.
  const { error: liveError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text: 'Live message from today' }],
  })
  if (liveError) throw new Error(`live message: ${liveError.message}`)

  gateway = await startBotGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  for (const row of configBefore) await setConfig(row.config_key, row.config_value)
  await deleteUser(admin, staff)
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

/** What get_unread_counts answers the member for the channel, for comparing before and after. */
async function unreadOf(user: SpecUser) {
  const client = await userClient(user)
  const { data, error } = await client.rpc('get_unread_counts')
  if (error) throw new Error(`get_unread_counts: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => row.channel_id === server.generalChannelId)
    .map((row) => ({ unread_messages: row.unread_messages, unread_mentions: row.unread_mentions }))
}

async function notificationCount(user: SpecUser): Promise<number> {
  const { count, error } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
  if (error) throw new Error(`notifications: ${error.message}`)
  return count ?? 0
}

/** A call to the gateway's Bridge v2 routes as the bridge bot. */
async function bridgeCall(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${gateway.url}/bridge/v2${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json: json as Record<string, any> | null, text }
}

test('history import is off until an instance admin turns it on', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=discord-bridge`)
  const pair = page.locator('[data-testid="pair-row"]').first()
  await expect(pair).toBeVisible({ timeout: 45000 })
  await expect(page.locator('[data-testid="import-unavailable"]')).toHaveText('History import is turned off on this instance.')
  await expect(page.locator('[data-testid="import-start"]')).toHaveCount(0)

  // The bridge is told the same, on its config and on every import route.
  const config = await bridgeCall('/config')
  expect(config.json?.history_import).toEqual({ enabled: false, reason: 'instance_off' })
  const refused = await bridgeCall('/imports')
  expect(refused.status).toBe(403)
  expect(refused.json).toEqual({ code: 'import_disabled', reason: 'instance_off' })
  const start = await bridgeCall('/imports', { method: 'POST', body: {} })
  expect(start.status).toBe(403)

  // The manager's own start is refused by the server too.
  const client = await userClient(owner)
  const { data: bridgeRow } = await admin.from('discord_bridges').select('id').eq('server_id', server.id).single()
  const { error: startError } = await client.rpc('discord_bridge_import_start', { p_bridge_id: bridgeRow!.id, p_harmony_channel_ids: null })
  expect(startError?.message).toBe('import_disabled')

  // An instance admin turns it on, and reads what that means.
  const staffContext = await browser.newContext()
  const staffPage = await staffContext.newPage()
  await signIn(staffPage, staff)
  await staffPage.goto('/admin?tab=config')
  const section = staffPage.locator('[data-testid="bridge-import-admin"]')
  await expect(section).toBeVisible({ timeout: 45000 })
  const mode = section.locator('[data-testid="import-mode"]')
  await expect(mode).toBeEnabled({ timeout: 20000 })
  await expect(mode).toHaveValue('off')
  await expect(section.locator('[data-testid="import-warning"]')).toHaveCount(0)
  await mode.selectOption('self_run')
  await expect(staffPage.locator('.Vue-Toastification__toast--success').filter({ hasText: 'History import settings saved' }))
    .toBeVisible({ timeout: 20000 })
  await expect(section.locator('[data-testid="import-warning"]')).toContainText('/bridge-privacy')
  await expect.poll(() => readConfig('bridge_history_import')).toBe('self_run')
  await staffContext.close()

  // The manager now has the button, and the bridge may import.
  await page.reload()
  await expect(pair).toBeVisible({ timeout: 45000 })
  await expect(pair.getByRole('button', { name: /^Import history/ })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('[data-testid="import-unavailable"]')).toHaveCount(0)
  expect((await bridgeCall('/config')).json?.history_import).toEqual({ enabled: true, reason: null })
  expect((await bridgeCall('/imports')).status).toBe(200)
})

test('a manager imports Discord history: old messages land quietly, in date order, under their Discord authors', async ({ page }) => {
  test.setTimeout(240_000)
  await setConfig('bridge_history_import', 'self_run')
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=discord-bridge`)
  const pair = page.locator('[data-testid="pair-row"]').first()
  await expect(pair).toBeVisible({ timeout: 45000 })
  await expect(pair.getByRole('button', { name: /^Import history/ })).toBeVisible()
  await pair.locator('[data-testid="import-start"]').click()

  // Nothing starts before the manager confirms.
  const consent = page.locator('[data-testid="import-consent"]')
  await expect(consent).toContainText('Import the history of 1 channel?')
  await expect(consent).toContainText('left the Discord server are skipped')
  await expect(consent.locator('[data-testid="import-consent-start"]')).toBeDisabled()
  expect((await bridgeCall('/imports')).json?.imports).toEqual([])
  await consent.locator('[data-testid="import-consent-check"]').check()
  await consent.locator('[data-testid="import-consent-start"]').click()
  await expect(pair.locator('[data-testid="import-state"]')).toBeVisible({ timeout: 30000 })

  // The bridge picks the job up.
  let jobId = ''
  await expect.poll(async () => {
    const listed = await bridgeCall('/imports')
    const job = (listed.json?.imports as Array<{ id: string; state: string; harmony_channel_id: string }> | undefined)
      ?.find((j) => j.harmony_channel_id === server.generalChannelId)
    jobId = job?.id ?? ''
    return job?.state
  }, { timeout: 30000 }).toBe('queued')

  const running = await bridgeCall(`/imports/${jobId}`, {
    method: 'PATCH',
    body: {
      state: 'running',
      phase: 'messages',
      start_at: '2023-06-01T00:00:00.000Z',
      start_discord_message_id: '1400000000000000202',
      channel_created_at: '2023-01-01T00:00:00.000Z',
    },
  })
  expect(running.status, running.text).toBe(200)

  const batch = await bridgeCall(`/imports/${jobId}/messages`, {
    method: 'POST',
    body: {
      messages: [
        {
          discord_message_id: '1400000000000000201',
          created_at: '2023-01-15T10:00:00.000Z',
          content: [{ type: 'text', text: 'Welcome to the old server' }],
          discord_user: ALICE,
        },
        {
          discord_message_id: '1400000000000000202',
          created_at: '2023-01-15T10:05:00.000Z',
          content: [
            { type: 'text', text: 'Back in 2023, hello ' },
            { type: 'mention', userId: member.id, username: member.username },
          ],
          discord_user: BOB,
        },
      ],
    },
  })
  expect(batch.status, batch.text).toBe(200)
  expect(batch.json?.inserted).toHaveLength(2)
  expect(batch.json?.skipped).toEqual([])
  const importedIds = (batch.json?.inserted as Array<{ id: string }>).map((m) => m.id)

  // The mention is stored as text: an imported message pings nobody.
  const { data: mentioning } = await admin.from('messages').select('content')
    .eq('channel_id', server.generalChannelId).eq('metadata->>discord_message_id', '1400000000000000202').single()
  expect((mentioning?.content as Array<{ type: string; text?: string }>).map((p) => p.type)).toEqual(['text', 'text'])
  expect((mentioning?.content as Array<{ text?: string }>)[1].text).toBe(`@${member.username}`)

  // A message dated in the future and one by an author who opted out are refused alone; the
  // message between them is stored.
  const optout = await bridgeCall(`/privacy/optouts/${CAROL.id}`, { method: 'PUT', body: {} })
  expect(optout.status, optout.text).toBe(200)
  const mixed = await bridgeCall(`/imports/${jobId}/messages`, {
    method: 'POST',
    body: {
      messages: [
        { discord_message_id: '1400000000000000203', created_at: new Date(Date.now() + 3_600_000).toISOString(),
          content: [{ type: 'text', text: 'From the future' }], discord_user: ALICE },
        { discord_message_id: '1400000000000000204', created_at: '2023-01-15T10:06:00.000Z',
          content: [{ type: 'text', text: 'Third old message' }], discord_user: ALICE },
        { discord_message_id: '1400000000000000205', created_at: '2023-01-15T10:07:00.000Z',
          content: [{ type: 'text', text: 'Carol opted out' }], discord_user: CAROL },
      ],
    },
  })
  expect(mixed.status, mixed.text).toBe(200)
  expect((mixed.json?.inserted as Array<{ discord_message_id: string }>).map((m) => m.discord_message_id)).toEqual(['1400000000000000204'])
  expect(mixed.json?.rejected).toEqual(expect.arrayContaining([
    { discord_message_id: '1400000000000000203', reason: 'future_date' },
    { discord_message_id: '1400000000000000205', reason: 'opted_out' },
  ]))
  expect(mixed.json?.rejected).toHaveLength(2)
  importedIds.push(...(mixed.json?.inserted as Array<{ id: string }>).map((m) => m.id))

  // Past the instance's rate the batch waits and stores nothing.
  await setConfig('bridge_import_messages_per_minute', 2)
  const limited = await bridgeCall(`/imports/${jobId}/messages`, {
    method: 'POST',
    body: { messages: [{ discord_message_id: '1400000000000000206', created_at: '2023-01-15T10:08:00.000Z',
      content: [{ type: 'text', text: 'Over the rate' }], discord_user: BOB }] },
  })
  expect(limited.status, limited.text).toBe(429)
  expect(limited.json?.code).toBe('import_rate_limited')
  expect(limited.json?.retry_after).toBeGreaterThan(0)
  expect(limited.json?.retry_after).toBeLessThanOrEqual(60)
  await setConfig('bridge_import_messages_per_minute', 600)

  // Baseline, right after the batch: the member sees the channel (the live message counts as
  // unread), so "unchanged" below cannot pass by reading the wrong user or channel.
  const unreadBefore = await unreadOf(member)
  const notificationsBefore = await notificationCount(member)
  expect(unreadBefore).not.toEqual([])

  const done = await bridgeCall(`/imports/${jobId}`, {
    method: 'PATCH',
    body: { state: 'done', reached_discord_message_id: '1400000000000000201', reached_at: '2023-01-15T10:00:00.000Z' },
  })
  expect(done.status, done.text).toBe(200)

  await expect(pair.locator('[data-testid="import-state"]')).toHaveText('Imported 3 messages', { timeout: 45000 })

  // The channel: both messages, oldest first, above the existing one, under the Discord names.
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  const list = page.locator('[data-testid="message-list"]')
  await expect(list.getByText('Live message from today')).toBeVisible({ timeout: 30000 })
  await expect(list.getByText('Welcome to the old server')).toBeVisible({ timeout: 30000 })
  await expect(list.getByText('Back in 2023, hello')).toBeVisible()
  await expect(list.getByText('Third old message')).toBeVisible()
  await expect(list.getByText('From the future')).toHaveCount(0)
  await expect(list.getByText('Carol opted out')).toHaveCount(0)
  await expect(list.getByText('Over the rate')).toHaveCount(0)
  const items = list.locator('.message-item')
  await expect.poll(async () => (await items.allTextContents()).map((text) => {
    if (text.includes('Welcome to the old server')) return 'first'
    if (text.includes('Back in 2023')) return 'second'
    if (text.includes('Live message from today')) return 'live'
    return 'other'
  }).filter((kind) => kind !== 'other')).toEqual(['first', 'second', 'live'])
  await expect(items.filter({ hasText: 'Welcome to the old server' })).toContainText('Alice')
  await expect(items.filter({ hasText: 'Back in 2023' })).toContainText('Bob')

  // Quiet: the mentioned member got no notification and no new unread.
  expect(await notificationCount(member)).toBe(notificationsBefore)
  expect(await unreadOf(member)).toEqual(unreadBefore)
  const { data: referencing, error: refError } = await admin
    .from('notifications')
    .select('id, data')
    .eq('user_id', member.id)
    .in('data->>message_id', importedIds)
  if (refError) throw new Error(`notifications by message: ${refError.message}`)
  expect(referencing).toEqual([])

  // Control: a live message that mentions the member does notify and count as unread, so the
  // checks above can fail.
  const { data: liveMention, error: liveMentionError } = await admin
    .from('messages')
    .insert({
      channel_id: server.generalChannelId,
      user_id: owner.id,
      content: [{ type: 'text', text: 'Live ping ' }, { type: 'mention', userId: member.id, username: member.username }],
    })
    .select('id')
    .single()
  if (liveMentionError || !liveMention) throw new Error(`live mention: ${liveMentionError?.message}`)
  await expect.poll(() => notificationCount(member), { timeout: 15000 }).toBeGreaterThan(notificationsBefore)
  expect(await unreadOf(member)).not.toEqual(unreadBefore)

  // The rows carry the import marker and their original dates.
  const { data: rows, error } = await admin
    .from('messages')
    .select('created_at, metadata')
    .eq('channel_id', server.generalChannelId)
    .eq('metadata->>history_import', 'true')
    .order('created_at')
  if (error) throw new Error(`messages: ${error.message}`)
  expect(rows?.map((r) => r.created_at.slice(0, 16))).toEqual(['2023-01-15T10:00', '2023-01-15T10:05', '2023-01-15T10:06'])
})
