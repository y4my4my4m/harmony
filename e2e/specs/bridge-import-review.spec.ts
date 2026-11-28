// Journeys: Discord history import after the 1.9.7 review (Harmony 1.9.8). The test acts as the
// bridge over the bot gateway's routes with the bridge bot's token, as bridge-history-import does.
//
// 1. A manager cancels an import whose bridge never answers: the pair reads "Cancelling…" with
//    Stop now, which ends it at once; the bridge's next call is refused. A paused job has Resume.
// 2. A start from Discord while the job is being cancelled keeps it running: the bridge's cancel
//    is refused and its next batch is stored.
// 3. A thread a moderator deleted is not created again by the next import, which the bridge is
//    told with invalid_thread and reason thread_deleted; a thread emptied of its messages is. The
//    replies phase links replies across the channel, and a purge drops the thread pairs, so the
//    re-import builds the thread on the re-imported starter with one notice.
// 4. The live relay of a message the import stored first takes its place: the mentioned member
//    is notified and counts it unread.
// 5. Reading and patching one job, 120 calls in a minute, meet no 429.
//
// The three instance_config keys the journeys write are restored afterwards.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
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
let server: SeededServer
let botId = ''
let bridgeId = ''
let token = ''
let gateway: BotGateway

const GUILD_ID = '900000000000000898'
const DISCORD_CHANNEL_ID = '1500000000000000100'
const DANA = { id: '1500000000000000101', username: 'dana', display_name: 'Dana' }

const CONFIG_KEYS = ['bridge_history_import', 'bridge_import_max_running', 'bridge_import_messages_per_minute']
let configBefore: Array<{ config_key: string; config_value: unknown }> = []

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const { data: stored, error: storedError } = await admin
    .from('instance_config').select('config_key, config_value').in('config_key', CONFIG_KEYS)
  if (storedError) throw new Error(`instance_config: ${storedError.message}`)
  configBefore = stored ?? []
  await setConfig('bridge_history_import', 'self_run')
  // No cap on running imports: the stale-job pause never runs, so only Stop now ends a job.
  await setConfig('bridge_import_max_running', 0)
  await setConfig('bridge_import_messages_per_minute', 600)

  owner = await createUser(admin, 'bir')
  member = await createUser(admin, 'birm')
  server = await seedServer(admin, owner, `Import review ${owner.username}`)
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

  const { data: bridge, error: bridgeError } = await admin
    .from('discord_bridges')
    .insert({
      server_id: server.id,
      bot_id: botId,
      mode: 'self',
      discord_guild_id: GUILD_ID,
      discord_guild_name: 'Old Guild',
      bridge_version: '2.8.0',
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
  bridgeId = bridge.id
  const { error: pairError } = await admin.from('discord_bridge_channels').insert({
    bridge_id: bridge.id,
    harmony_channel_id: server.generalChannelId,
    discord_channel_id: DISCORD_CHANNEL_ID,
    discord_channel_name: 'general',
    direction: 'both',
    created_by: owner.id,
  })
  if (pairError) throw new Error(`pair: ${pairError.message}`)

  gateway = await startBotGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  if (botId) await admin.from('bots').delete().eq('id', botId)
  for (const row of configBefore) await setConfig(row.config_key, row.config_value)
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

/** A call to the gateway as the bridge bot; `path` is under /bridge/v2 unless it starts with /api. */
async function bridgeCall(path: string, init: { method?: string; body?: unknown } = {}) {
  const url = path.startsWith('/api/') ? `${gateway.url}${path}` : `${gateway.url}/bridge/v2${path}`
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, json: json as Record<string, any> | null, text }
}

type Job = { id: string; state: string; cancel_requested: boolean; harmony_channel_id: string }

async function job(): Promise<Job | undefined> {
  const listed = await bridgeCall('/imports')
  return (listed.json?.imports as Job[] | undefined)?.find((j) => j.harmony_channel_id === server.generalChannelId)
}

/** The job, started by the manager's RPC (the UI's own call) and set running by the bridge. */
async function running(): Promise<string> {
  const client = await userClient(owner)
  const { error } = await client.rpc('discord_bridge_import_start', { p_bridge_id: bridgeId, p_harmony_channel_ids: [server.generalChannelId] })
  if (error) throw new Error(`start: ${error.message}`)
  const id = (await job())!.id
  const patched = await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'running' } })
  expect(patched.status, patched.text).toBe(200)
  return id
}

const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  discord_message_id: id, created_at: '2023-03-01T10:00:00.000Z', content: [{ type: 'text', text }], discord_user: DANA, ...extra,
})

test('a manager stops an import its bridge never finishes, and resumes a paused one', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=discord-bridge`)
  const pair = page.locator('[data-testid="pair-row"]').first()
  await expect(pair).toBeVisible({ timeout: 45000 })
  await pair.locator('[data-testid="import-start"]').click()
  const consent = page.locator('[data-testid="import-consent"]')
  await consent.locator('[data-testid="import-consent-check"]').check()
  await consent.locator('[data-testid="import-consent-start"]').click()
  await expect.poll(async () => (await job())?.state, { timeout: 30000 }).toBe('queued')
  const id = (await job())!.id
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'running' } })).status).toBe(200)

  // The bridge goes away. Cancel asks it to stop; nobody answers.
  await expect(pair.locator('[data-testid="import-cancel"]')).toBeVisible({ timeout: 45000 })
  await pair.locator('[data-testid="import-cancel"]').click()
  await expect(pair.locator('[data-testid="import-state"]')).toHaveText('Cancelling…', { timeout: 30000 })
  await expect(pair.locator('[data-testid="import-stop-hint"]')).toContainText('If it is offline')
  await expect(pair.getByRole('button', { name: 'Stop the import for #general now' })).toBeEnabled()

  await pair.locator('[data-testid="import-stop"]').click()
  await expect(pair.locator('[data-testid="import-state"]')).toHaveText('Cancelled', { timeout: 30000 })
  expect((await job())?.state).toBe('cancelled')
  const late = await bridgeCall(`/imports/${id}/messages`, { method: 'POST', body: { messages: [message('1500000000000000201', 'late')] } })
  expect(late.status, late.text).toBe(409)
  expect(late.json?.code).toBe('import_not_running')

  // A job its bridge paused is resumed from its own row.
  await running()
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'paused' } })).status).toBe(200)
  await expect(pair.locator('[data-testid="import-state"]')).toHaveText('Paused: waiting for the bridge', { timeout: 45000 })
  await expect(pair.getByRole('button', { name: 'Resume the import for #general' })).toBeVisible()
  await pair.locator('[data-testid="import-retry"]').click()
  await consent.locator('[data-testid="import-consent-check"]').check()
  await consent.locator('[data-testid="import-consent-start"]').click()
  await expect.poll(async () => (await job())?.state, { timeout: 30000 }).toBe('queued')
  await expect(pair.locator('[data-testid="import-state"]')).toHaveText('Waiting', { timeout: 45000 })
  expect((await bridgeCall(`/imports/${id}/cancel`, { method: 'POST' })).status).toBe(200)
})

test('a start from Discord while the import is being cancelled keeps it running', async () => {
  const id = await running()
  expect((await bridgeCall(`/imports/${id}/cancel`, { method: 'POST' })).json?.imports?.[0]?.cancel_requested).toBe(true)

  const started = await bridgeCall('/imports', { method: 'POST', body: { discord_channel_ids: [DISCORD_CHANNEL_ID], requested_by: DANA } })
  expect(started.status, started.text).toBe(201)
  expect(started.json?.imports?.[0]).toMatchObject({ id, state: 'running', cancel_requested: false })

  // The bridge had read the request: its cancel is refused, and the job goes on.
  const cancel = await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'cancelled' } })
  expect(cancel.status).toBe(409)
  expect(cancel.json?.code).toBe('invalid_transition')
  const batch = await bridgeCall(`/imports/${id}/messages`, { method: 'POST', body: { messages: [message('1500000000000000202', 'still importing')] } })
  expect(batch.status, batch.text).toBe(200)
  expect(batch.json?.inserted).toHaveLength(1)
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)
})

test('threads: a deleted one stays deleted, replies link across pages, a purge rebuilds them on their starters', async () => {
  test.setTimeout(120_000)
  let id = await running()
  const starter = message('1500000000000000300', 'Thread starter by Dana')
  const posted = await bridgeCall(`/imports/${id}/messages`, {
    method: 'POST',
    body: { messages: [
      message('1500000000000000310', 'A reply to an older message', { reply_to_discord_message_id: '1500000000000000309', created_at: '2023-03-02T10:00:00.000Z' }),
      starter,
    ] },
  })
  expect(posted.status, posted.text).toBe(200)
  // The reply's target, in a later batch: only the replies phase links the two.
  const older = await bridgeCall(`/imports/${id}/messages`, {
    method: 'POST', body: { messages: [message('1500000000000000309', 'The older message', { created_at: '2023-02-01T10:00:00.000Z' })] },
  })
  expect(older.json?.inserted).toHaveLength(1)
  const thread = (discordThreadId: string, starterId: string | null) => bridgeCall(`/imports/${id}/threads`, {
    method: 'POST',
    body: { discord_thread_id: discordThreadId, name: `topic ${discordThreadId}`, created_at: '2023-03-01T11:00:00.000Z',
      starter_discord_message_id: starterId, discord_user: DANA },
  })

  const deleted = await thread('1500000000000000401', null)
  const emptied = await thread('1500000000000000402', null)
  const onStarter = await thread('1500000000000000300', '1500000000000000300')
  for (const t of [deleted, emptied, onStarter]) expect(t.status, t.text).toBe(200)
  const inThreads = await bridgeCall(`/imports/${id}/messages`, {
    method: 'POST',
    body: { messages: [
      message('1500000000000000411', 'in the deleted thread', { thread_id: deleted.json?.thread_id }),
      message('1500000000000000412', 'in the emptied thread', { thread_id: emptied.json?.thread_id }),
      message('1500000000000000413', 'in the starter thread', { thread_id: onStarter.json?.thread_id }),
    ] },
  })
  expect(inThreads.json?.inserted).toHaveLength(3)

  // The replies phase links the reply whose target arrived later.
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { phase: 'replies' } })).status).toBe(200)
  const link = await bridgeCall(`/imports/${id}/replies/link`, { method: 'POST' })
  expect(link.status, link.text).toBe(200)
  expect(link.json?.linked).toBe(1)
  const { data: reply } = await admin.from('messages').select('reply_to')
    .eq('channel_id', server.generalChannelId).eq('metadata->>discord_message_id', '1500000000000000310').single()
  const { data: target } = await admin.from('messages').select('id')
    .eq('channel_id', server.generalChannelId).eq('metadata->>discord_message_id', '1500000000000000309').single()
  expect(reply?.reply_to).toBe(target?.id)
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)

  // A moderator deletes one thread; the other loses its only message, and with it the thread.
  const moderator = await userClient(owner)
  const { error: deleteError } = await moderator.from('threads').delete().eq('id', deleted.json?.thread_id)
  if (deleteError) throw new Error(`thread delete: ${deleteError.message}`)
  const { error: emptyError } = await admin.from('messages').update({ is_deleted: true })
    .eq('channel_id', server.generalChannelId).eq('metadata->>discord_message_id', '1500000000000000412')
  if (emptyError) throw new Error(`message delete: ${emptyError.message}`)

  id = await running()
  const again = await thread('1500000000000000401', null)
  expect(again.status).toBe(400)
  expect(again.json).toEqual({ code: 'invalid_thread', reason: 'thread_deleted' })
  const back = await thread('1500000000000000402', null)
  expect(back.status, back.text).toBe(200)
  expect(back.json?.thread_id).not.toBe(emptied.json?.thread_id)
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)

  // A purge of the server's bridged messages, then a re-import of the starter and its thread.
  for (let i = 0; i < 10; i++) {
    const { data: purged, error: purgeError } = await moderator.rpc('bridge_privacy_purge_server', { p_server_id: server.id, p_platform: 'discord' })
    if (purgeError) throw new Error(`purge: ${purgeError.message}`)
    if (!(purged as { more?: boolean }).more) break
  }
  id = await running()
  const reimported = await bridgeCall(`/imports/${id}/messages`, { method: 'POST', body: { messages: [starter] } })
  expect(reimported.json?.inserted).toHaveLength(1)
  const rebuilt = await thread('1500000000000000300', '1500000000000000300')
  expect(rebuilt.status, rebuilt.text).toBe(200)
  expect(rebuilt.json?.thread_id).not.toBe(onStarter.json?.thread_id)
  const { data: rebuiltRow } = await admin.from('threads').select('parent_message_id, name').eq('id', rebuilt.json?.thread_id).single()
  expect(rebuiltRow).toEqual({ parent_message_id: reimported.json?.inserted[0].id, name: 'topic 1500000000000000300' })
  // The purge took the emptied thread's notice with it: the rebuilt thread's is the only one.
  const { data: notices } = await admin.from('messages').select('metadata')
    .eq('channel_id', server.generalChannelId).eq('metadata->>type', 'thread_created')
    .in('metadata->>thread_id', [onStarter.json?.thread_id, rebuilt.json?.thread_id])
  expect((notices ?? []).map((n) => (n.metadata as { thread_id: string }).thread_id)).toEqual([rebuilt.json?.thread_id])
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)
})

test('the live relay of a message the import stored first notifies like any relay', async () => {
  const id = await running()
  const MESSAGE = '1500000000000000500'
  const imported = await bridgeCall(`/imports/${id}/messages`, {
    method: 'POST',
    body: { messages: [message(MESSAGE, 'Imported first', { created_at: new Date(Date.now() - 10 * 60_000).toISOString() })] },
  })
  expect(imported.json?.inserted).toHaveLength(1)
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)

  const notified = async () => {
    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', member.id)
    return count ?? 0
  }
  const before = await notified()

  // The relay, delayed past the importer's margin, arrives with the mention the import left as text.
  const relay = await bridgeCall(`/api/v1/channels/${server.generalChannelId}/messages`, {
    method: 'POST',
    body: {
      content: [{ type: 'text', text: 'Imported first, hello ' }, { type: 'mention', userId: member.id, username: member.username }],
      metadata: { discord_message_id: MESSAGE, discord_user: DANA },
    },
  })
  expect(relay.status, relay.text).toBe(201)
  expect(relay.json?.id).not.toBe(imported.json?.inserted[0].id)

  const { data: rows } = await admin.from('messages').select('id, metadata')
    .eq('channel_id', server.generalChannelId).eq('metadata->>discord_message_id', MESSAGE)
  expect(rows).toHaveLength(1)
  expect(rows?.[0].id).toBe(relay.json?.id)
  expect((rows?.[0].metadata as { history_import?: boolean }).history_import).toBeUndefined()
  await expect.poll(notified, { timeout: 15000 }).toBeGreaterThan(before)
  const client = await userClient(member)
  const { data: unread } = await client.rpc('get_unread_counts')
  const general = ((unread ?? []) as Array<{ channel_id: string; unread_mentions: number }>).find((r) => r.channel_id === server.generalChannelId)
  expect(general?.unread_mentions).toBeGreaterThan(0)
})

test('an import reads and patches its job 120 times in a minute without a 429', async () => {
  const id = await running()
  const statuses: number[] = []
  for (let i = 0; i < 60; i++) {
    statuses.push((await bridgeCall(`/imports/${id}`)).status)
    statuses.push((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { threads_done: i } })).status)
  }
  expect(statuses.filter((s) => s !== 200)).toEqual([])
  expect((await bridgeCall(`/imports/${id}`, { method: 'PATCH', body: { state: 'done' } })).status).toBe(200)
})
