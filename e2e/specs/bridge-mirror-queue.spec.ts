// Journey: Discord files of bridged messages reach Harmony storage through the bot gateway's
// mirror queue (bridge_attachment_mode 'mirror'). The test is the bridge: it holds the bridge
// bot's token and posts and edits over the gateway's REST routes. The "Discord CDN" is a local
// HTTPS server reached through a CONNECT proxy (fakeHttpsHost). Each file states a size over
// BRIDGE_MIRROR_INLINE_MAX_BYTES, so none is stored inside the request: every message goes to
// the queue the gateway's worker drains.
//
//   dead link  a message with an attachment link Discord no longer signs (a deleted
//              attachment) and a signed one: the signed file is stored at once, while the dead
//              link waits for a re-sign from the bridge, which is offline here. The server's
//              usage is the stored file's size, counted by the triggers on storage.objects.
//   edit       a message edited while the worker downloads its file, the edit adding a second
//              file: both files are stored.
//
// The stack runs the bot gateway as a child process (see botGateway.ts). The
// bridge_attachment_mode key is restored afterwards.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, seedServer, userClient, type SeededServer, type SpecUser } from './harness'
import { startBotGateway, type BotGateway } from './botGateway'
import { fakeHttpsHost, type FakeHttpsHost } from './fakeHttpsHost'
import { PHOTO, expectStripped } from './photoDetails'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let botId = ''
let token = ''
let gateway: BotGateway
let cdn: FakeHttpsHost
let modeBefore: { config_key: string; config_value: unknown } | null = null

const CDN = 'https://cdn.discordapp.com/attachments/1400000000000000200/1400000000000000201'
const requests: string[] = []
let releaseHeld: () => void = () => {}
const held = new Promise<void>((resolve) => { releaseHeld = resolve })

/** A link Discord signed for a day. */
function signed(name: string): string {
  const now = Math.floor(Date.now() / 1000)
  return `${CDN}/${name}.jpg?ex=${(now + 86_400).toString(16)}&is=${now.toString(16)}&hm=e2e`
}

const file = (name: string, url = signed(name)) =>
  ({ type: 'file', fileType: 'image', fileName: `${name}.jpg`, contentType: 'image/jpeg', fileSize: PHOTO.length, url })

async function bot(method: 'POST' | 'PATCH', route: string, body: unknown): Promise<Response> {
  return fetch(`${gateway.url}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function parts(id: string): Promise<Array<{ type: string; url?: string; path?: string; text?: string }>> {
  const { data, error } = await admin.from('messages').select('content').eq('id', id).single()
  if (error) throw new Error(`message: ${error.message}`)
  return data!.content
}

const storedPath = expect.stringMatching(/^c\/[0-9a-f-]{36}\/bridge\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  owner = await createUser(admin, 'mrq')
  server = await seedServer(admin, owner, `Mirror queue ${owner.username}`)
  const { data, error } = await (await userClient(owner)).rpc('create_bot', {
    p_username: `bridge${owner.username.slice(-8)}`, p_display_name: 'Discord Bridge', p_bio: 'Relays messages',
    p_bot_type: 'bridge', p_is_public: false,
  })
  if (error || !data?.bot?.id || !data?.token) throw new Error(`create_bot: ${error?.message}`)
  botId = data.bot.id
  token = data.token
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)
  // bridge_mirror_enqueue queues only messages of a bot that runs a bridge.
  const { error: bridgeError } = await admin.from('discord_bridges').insert({
    server_id: server.id, bot_id: botId, mode: 'self', discord_guild_id: '900000000000000555', created_by: owner.id,
  })
  if (bridgeError) throw new Error(`bridge: ${bridgeError.message}`)

  const { data: previous } = await admin.from('instance_config')
    .select('config_key, config_value').eq('config_key', 'bridge_attachment_mode').maybeSingle()
  modeBefore = previous
  const { error: modeError } = await admin.from('instance_config')
    .upsert({ config_key: 'bridge_attachment_mode', config_value: 'mirror' }, { onConflict: 'config_key' })
  if (modeError) throw new Error(`bridge_attachment_mode: ${modeError.message}`)

  // Discord answers 404 to an attachment link without a signature, even for a live file.
  cdn = await fakeHttpsHost('cdn.discordapp.com', async (req, res) => {
    const url = new URL(req.url ?? '/', 'https://cdn.discordapp.com')
    requests.push(url.pathname)
    if (!url.searchParams.has('ex')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('This content is no longer available.')
      return
    }
    if (url.pathname.endsWith('/held.jpg')) await held
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': PHOTO.length })
    res.end(PHOTO)
  })
  gateway = await startBotGateway({ ...cdn.env, BRIDGE_MIRROR_INLINE_MAX_BYTES: '1', BRIDGE_MIRROR_POLL_MS: '250' })
})

test.afterAll(async () => {
  releaseHeld()
  await gateway?.stop()
  await cdn?.close()
  if (modeBefore) await admin.from('instance_config').upsert(modeBefore, { onConflict: 'config_key' })
  else await admin.from('instance_config').delete().eq('config_key', 'bridge_attachment_mode')
  await admin.from('discord_bridges').delete().eq('server_id', server?.id ?? '')
  await deleteUser(admin, owner)
})

test('a dead attachment link does not keep the message\'s other file from storage', async () => {
  test.setTimeout(120_000)
  const dead = `${CDN}/gone.jpg`
  const res = await bot('POST', `/channels/${server.generalChannelId}/messages`, {
    content: [{ type: 'text', text: 'two photos' }, file('gone', dead), file('live')],
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const { id } = await res.json() as { id: string }

  await expect.poll(async () => (await parts(id))[2]?.path, { timeout: 60_000 }).toEqual(storedPath)
  const stored = await parts(id)
  expect(stored[1]).toMatchObject({ url: dead })
  expect(stored[1].path).toBeUndefined()
  expect(requests).toContain(new URL(signed('live')).pathname)

  await test.step('the stored file is the photo without its details', async () => {
    const { data, error } = await admin.storage.from('message_media').download(stored[2].path!)
    if (error || !data) throw new Error(`download: ${error?.message}`)
    expectStripped(Buffer.from(await data.arrayBuffer()))
  })

  await test.step('the dead link waits for the bridge to re-sign it', async () => {
    const { data: row } = await admin.from('bridge_mirror_queue').select('state, attempts, next_attempt_at').eq('message_id', id).single()
    expect(row).toMatchObject({ state: 'queued', attempts: 0 })
    expect(Date.parse(row!.next_attempt_at)).toBeGreaterThan(Date.now() + 10 * 60_000)
  })

  await test.step('the server\'s usage is the stored file\'s size', async () => {
    const { data: objects, error } = await admin.storage.from('message_media')
      .list(`c/${server.generalChannelId}/bridge/${botId}`)
    if (error) throw new Error(`list: ${error.message}`)
    const size = (objects ?? []).reduce((sum, o) => sum + Number(o.metadata?.size ?? 0), 0)
    expect(size).toBeGreaterThan(0)
    const { data: usage, error: usageError } = await admin.rpc('bridge_mirror_server_bytes', { p_server_id: server.id })
    if (usageError) throw new Error(`usage: ${usageError.message}`)
    expect(Number(usage)).toBe(size)
  })
})

test('an edit made while the worker downloads gets its new file stored too', async () => {
  test.setTimeout(120_000)
  const res = await bot('POST', `/channels/${server.generalChannelId}/messages`, {
    content: [{ type: 'text', text: 'one photo' }, file('held')],
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const { id } = await res.json() as { id: string }

  // The worker is downloading held.jpg, which the CDN holds back.
  await expect.poll(() => requests.filter((p) => p.endsWith('/held.jpg')).length, { timeout: 60_000 }).toBe(1)
  const edit = await bot('PATCH', `/messages/${id}`, {
    content: [{ type: 'text', text: 'two photos now' }, file('held'), file('added')],
  })
  expect(edit.status, await edit.clone().text()).toBe(200)
  releaseHeld()

  await expect.poll(async () => (await parts(id)).map((p) => p.path), { timeout: 60_000 })
    .toEqual([undefined, storedPath, storedPath])
  expect((await parts(id))[0]).toMatchObject({ text: 'two photos now' })
  await expect.poll(async () => {
    const { data } = await admin.from('bridge_mirror_queue').select('message_id').eq('message_id', id)
    return data?.length
  }, { timeout: 30_000 }).toBe(0)
})
