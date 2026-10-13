// Journey: a bot that reconnects before the gateway sees its old socket close stays online,
// and a Discord bridge keeps the members it registered. A client sees a dropped connection
// (1006) first and identifies on a new socket; the old socket's close reaches the gateway
// after that. The bot reads offline and its members are released only when its last
// connection closes.

import { test, expect } from '@playwright/test'
import WebSocket from 'ws'
import {
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
let owner: SpecUser
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
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)
  ownerJwt = (await client.auth.getSession()).data.session!.access_token
  gateway = await startBotGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
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
