// Journey: a bot that reconnects before the gateway sees its old socket close stays online,
// and a Discord bridge keeps the members it registered. A client sees a dropped connection
// (1006) first and identifies on a new socket; the old socket's close reaches the gateway
// after that. The bot reads offline and its members are released only when its last
// connection closes.
//
// A bot holds at most WS_MAX_CONNECTIONS_PER_BOT (default 5) identified connections; the
// identify past it closes with 4029. A socket without a successful identify within
// WS_IDENTIFY_TIMEOUT_MS (2 s here) closes with 4003.
//
// The server routes read the stored columns: members page by user id (user_servers has no
// joined_at), the server icon comes from servers.icon, a voice channel reports Discord's type
// 2. MESSAGE_DELETE of a thread message names its thread, for a REST hard delete and for a
// soft delete in the app.

import { test, expect } from '@playwright/test'
import WebSocket from 'ws'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  seedServer,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'

const admin = adminClient()
const IDENTIFY_TIMEOUT_MS = 2_000
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let botId = ''
let token = ''
let gateway: BotGateway
let ownerJwt = ''

const ALICE = { id: '80351110224678912', username: 'alice', displayName: 'Alice', avatarUrl: '', source: 'discord' }

test.beforeAll(async () => {
  owner = await createUser(admin, 'bgr')
  server = await seedServer(admin, owner, `Bridge ${owner.username}`)
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
  member = await createUser(admin, 'bgm')
  await addMember(admin, member, server.id)
  ownerJwt = (await client.auth.getSession()).data.session!.access_token
  gateway = await startBotGateway({ WS_IDENTIFY_TIMEOUT_MS: String(IDENTIFY_TIMEOUT_MS) })
})

test.afterAll(async () => {
  await gateway?.stop()
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

/** Opens a socket, identifies, registers the bridge's members; resolves with the session id. */
async function connectBridge(): Promise<{ ws: WebSocket; sessionId: string }> {
  const ws = new WebSocket(gateway.wsUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const ready = new Promise<any>((resolve) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.t === 'READY') resolve(frame.d)
    })
  })
  ws.send(JSON.stringify({ op: 2, d: { token } }))
  const { session_id: sessionId } = await ready
  ws.send(JSON.stringify({ op: 6, d: { channels: [{ harmonyChannelId: server.generalChannelId, members: [ALICE] }] } }))
  return { ws, sessionId }
}

async function presence() {
  const { data } = await admin.from('bot_presence').select('status, gateway_session_id').eq('bot_id', botId).single()
  return data as { status: string; gateway_session_id: string }
}

async function bridgedIds(): Promise<string[]> {
  const res = await fetch(`${gateway.url}/bridged-users/${server.generalChannelId}`, {
    headers: { Authorization: `Bearer ${ownerJwt}` },
  })
  expect(res.status).toBe(200)
  return ((await res.json()).users as Array<{ id: string }>).map((u) => u.id)
}

test('a reconnected bridge stays online and keeps its members', async () => {
  test.setTimeout(120_000)

  const older = await connectBridge()
  await expect.poll(bridgedIds, { timeout: 15000 }).toEqual([ALICE.id])

  const newer = await connectBridge()
  await expect.poll(async () => (await presence()).gateway_session_id, { timeout: 15000 }).toBe(newer.sessionId)

  await test.step('the old socket closes after the reconnect', async () => {
    const closed = new Promise((resolve) => older.ws.once('close', resolve))
    older.ws.terminate()
    await closed
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await presence()).toEqual({ status: 'online', gateway_session_id: newer.sessionId })
    expect(await bridgedIds()).toEqual([ALICE.id])
  })

  await test.step('the last socket closing takes the bot offline and releases its members', async () => {
    newer.ws.close()
    await expect.poll(async () => (await presence()).status, { timeout: 15000 }).toBe('offline')
    await expect.poll(bridgedIds, { timeout: 15000 }).toEqual([])
  })
})

/** Opens a socket and identifies; resolves with the socket and READY, or the close code. */
async function identify(): Promise<{ ws: WebSocket; ready?: any; close?: { code: number; reason: string } }> {
  const ws = new WebSocket(gateway.wsUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const outcome = new Promise<{ ready?: any; close?: { code: number; reason: string } }>((resolve) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.t === 'READY') resolve({ ready: frame.d })
    })
    ws.once('close', (code, reason) => resolve({ close: { code, reason: reason.toString() } }))
  })
  ws.send(JSON.stringify({ op: 2, d: { token } }))
  return { ws, ...(await outcome) }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${gateway.url}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...init.headers },
  })
}

/** Identified connections of the bot in the gateway process. */
async function connectionCount(): Promise<number> {
  const res = await fetch(`${gateway.url}/status`, { headers: { Authorization: `Bearer ${ownerJwt}` } })
  expect(res.status).toBe(200)
  return ((await res.json()).bots as Array<{ id: string }>).filter((b) => b.id === botId).length
}

test('a bot holds at most five gateway connections', async () => {
  test.setTimeout(60_000)
  const open: WebSocket[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const { ws, ready } = await identify()
      open.push(ws)
      expect(ready?.session_id).toBeTruthy()
    }

    const refused = await identify()
    open.push(refused.ws)
    expect(refused.close).toEqual({ code: 4029, reason: 'Too many connections' })
    expect(await connectionCount()).toBe(5)

    open.shift()!.close()
    await expect.poll(connectionCount, { timeout: 15000 }).toBe(4)
    const again = await identify()
    open.push(again.ws)
    expect(again.ready?.session_id).toBeTruthy()
  } finally {
    for (const ws of open) ws.close()
    await expect.poll(connectionCount, { timeout: 15000 }).toBe(0)
  }
})

test('server routes read the stored columns and MESSAGE_DELETE names the thread', async () => {
  test.setTimeout(90_000)

  await test.step('members page by user id', async () => {
    const expected = [owner.id, member.id].sort()
    const first = await api(`/servers/${server.id}/members?limit=1`)
    expect(first.status).toBe(200)
    const page1 = await first.json() as Array<{ user: { id: string }; joined_at: string }>
    expect(page1.map((m) => m.user.id)).toEqual([expected[0]])
    expect(Date.parse(page1[0].joined_at)).not.toBeNaN()

    const page2 = await (await api(`/servers/${server.id}/members?limit=1&after=${expected[0]}`)).json()
    expect(page2.map((m: { user: { id: string } }) => m.user.id)).toEqual([expected[1]])

    const page3 = await (await api(`/guilds/${server.id}/members?after=${expected[1]}`)).json()
    expect(page3).toEqual([])
  })

  await test.step('the server icon and channel types come from their columns', async () => {
    const { error: iconError } = await admin.from('servers').update({ icon: `${server.id}/icon.png` }).eq('id', server.id)
    expect(iconError).toBeNull()
    const { error: voiceError } = await admin.from('channels').insert({ server_id: server.id, name: 'Lounge', type: 1, order: 9 })
    expect(voiceError).toBeNull()

    const guild = await (await api(`/servers/${server.id}`)).json()
    expect(guild.icon).toMatch(new RegExp(`/storage/v1/render/image/public/server_icons/${server.id}/icon\\.png\\?`))

    const channels = await (await api(`/servers/${server.id}/channels`)).json() as Array<{ name: string; type: number }>
    expect(channels.find((c) => c.name === 'general')?.type).toBe(0)
    expect(channels.find((c) => c.name === 'Lounge')?.type).toBe(2)
  })

  await test.step('MESSAGE_DELETE of a thread message carries thread_id', async () => {
    const created = await api(`/channels/${server.generalChannelId}/threads`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Plans' }),
    })
    expect(created.status).toBe(201)
    const threadId = (await created.json()).id as string

    const { ws, ready } = await identify()
    expect(ready).toBeTruthy()
    const deletes: Array<{ id: string; channel_id: string; thread_id: string | null }> = []
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.t === 'MESSAGE_DELETE') deletes.push(frame.d)
    })
    try {
      const sent = await api(`/channels/${server.generalChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'in the thread', thread_id: threadId }),
      })
      expect(sent.status).toBe(201)
      const botMessageId = (await sent.json()).id as string
      expect((await api(`/messages/${botMessageId}`, { method: 'DELETE' })).status).toBe(204)
      await expect.poll(() => deletes.find((d) => d.id === botMessageId), { timeout: 15000 })
        .toEqual(expect.objectContaining({ channel_id: server.generalChannelId, thread_id: threadId }))

      const { data: memberMessage, error } = await admin
        .from('messages')
        .insert({ channel_id: server.generalChannelId, thread_id: threadId, user_id: member.id, content: [{ type: 'text', text: 'see you there' }] })
        .select('id')
        .single()
      expect(error).toBeNull()
      const { error: softError } = await admin.from('messages').update({ is_deleted: true }).eq('id', memberMessage!.id)
      expect(softError).toBeNull()
      await expect.poll(() => deletes.find((d) => d.id === memberMessage!.id), { timeout: 15000 })
        .toEqual(expect.objectContaining({ channel_id: server.generalChannelId, thread_id: threadId }))
    } finally {
      ws.close()
      await expect.poll(connectionCount, { timeout: 15000 }).toBe(0)
    }
  })
})

test('a socket that never identifies is closed with 4003', async () => {
  const ws = new WebSocket(gateway.wsUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const opened = Date.now()
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  ws.send(JSON.stringify({ op: 1 }))

  expect(await closed).toEqual({ code: 4003, reason: 'Not authenticated' })
  expect(Date.now() - opened).toBeGreaterThanOrEqual(IDENTIFY_TIMEOUT_MS - 100)
})
