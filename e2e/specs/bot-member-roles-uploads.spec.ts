// Journey: a bot gives members roles and posts files (bot API, 1.9.8). Through bot-gateway's REST
// routes a bot installed with Manage roles gives and takes a member's role, and one with Attach
// files uploads an image and posts it.
//
// Covered: the role reaching the member and the server audit log naming the bot; @everyone, an
// administrator role and a role over the bot's reach refused; the uploaded image shown inline to
// another member; a photo's GPS and camera tags gone from the stored file; uploads refused without
// Attach files; message events carrying server_id.

import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBotGateway, type BotGateway } from './botGateway'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'tests/fixtures/media-metadata')
const GPS_MARKERS = ['HarmonyCam', 'GPSLatitude', 'Tokyo']

const admin = adminClient()
let owner: SpecUser
let alice: SpecUser
let server: SeededServer
let botId = ''
let botName = ''
let token = ''
let gateway: BotGateway
let levelRole = ''
let adminRole = ''
let everyoneRole = ''

async function api(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${gateway.url}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function upload(file: string, type: string, name: string): Promise<Response> {
  return fetch(`${gateway.url}/api/v1/channels/${server.generalChannelId}/attachments?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': type },
    body: fs.readFileSync(path.join(FIXTURES, file)),
  })
}

async function aliceRoles(): Promise<string[]> {
  const { data } = await admin.from('user_roles').select('role_id').eq('user_id', alice.id).eq('server_id', server.id)
  return (data ?? []).map((r: { role_id: string }) => r.role_id)
}

async function setInstall(flags: Record<string, boolean>): Promise<void> {
  const { error } = await admin.from('bot_server_permissions').update(flags).eq('bot_id', botId).eq('server_id', server.id)
  if (error) throw new Error(`install update: ${error.message}`)
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'bro')
  alice = await createUser(admin, 'bra')
  server = await seedServer(admin, owner, `Bot roles ${owner.username}`)
  await addMember(admin, alice, server.id)

  const client = await userClient(owner)
  botName = `lvl${owner.username.slice(-8)}`
  const { data, error } = await client.rpc('create_bot', {
    p_username: botName,
    p_display_name: 'Levelbot',
    p_bio: 'Gives level roles',
    p_bot_type: 'bot',
    p_is_public: false,
  })
  if (error || !data?.bot?.id || !data?.token) throw new Error(`create_bot: ${error?.message}`)
  botId = data.bot.id
  token = data.token
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: botId, server_id: server.id, installed_by: owner.id, is_active: true,
    read_messages: true, send_messages: true, attach_files: true, manage_roles: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)

  const { data: roles, error: rolesError } = await admin
    .from('server_roles')
    .insert([
      { server_id: server.id, name: 'Level 5', position: 1, permissions: '0', is_default: false, is_admin: false },
      { server_id: server.id, name: 'Staff', position: 900, permissions: '8', is_default: false, is_admin: true },
    ])
    .select('id, name')
  if (rolesError || !roles) throw new Error(`roles: ${rolesError?.message}`)
  levelRole = roles.find((r: { name: string }) => r.name === 'Level 5')!.id
  adminRole = roles.find((r: { name: string }) => r.name === 'Staff')!.id
  const { data: everyone } = await admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  everyoneRole = everyone!.id

  gateway = await startBotGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
  await deleteUser(admin, alice)
  await deleteUser(admin, owner)
})

test('a bot gives and takes a member\'s role, and the audit log names it', async ({ page }) => {
  test.setTimeout(90_000)
  const memberRoles = `/servers/${server.id}/members/${alice.id}/roles`
  // Roles Alice holds from joining (the server's join role, if any).
  const before = (await aliceRoles()).sort()
  expect(before).not.toContain(levelRole)

  expect((await api('PUT', `${memberRoles}/${levelRole}`)).status).toBe(204)
  expect((await aliceRoles()).sort()).toEqual([...before, levelRole].sort())
  expect((await api('PUT', `${memberRoles}/${levelRole}`)).status).toBe(204)

  const listed = await (await api('GET', `/servers/${server.id}/members`)).json() as Array<{ user: { id: string }; roles: string[] }>
  expect(listed.find((m) => m.user.id === alice.id)?.roles).toContain(levelRole)

  for (const refused of [everyoneRole, adminRole]) {
    expect((await api('PUT', `${memberRoles}/${refused}`)).status).toBe(403)
  }
  expect((await aliceRoles()).sort()).toEqual([...before, levelRole].sort())

  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=audit-log`)
  const entries = page.locator('[data-test="audit-entry"]')
  await expect(entries.filter({ hasText: `Levelbot gave ${alice.displayName} the role Level 5` })).toHaveCount(1, { timeout: 30000 })

  expect((await api('DELETE', `${memberRoles}/${levelRole}`)).status).toBe(204)
  expect((await aliceRoles()).sort()).toEqual(before)
  await page.reload()
  await expect(entries.filter({ hasText: 'Levelbot' }).filter({ hasText: alice.displayName })).toHaveCount(2, { timeout: 30000 })
})

test('a bot uploads an image and posts it; members see it and the photo keeps no location', async ({ page }) => {
  test.setTimeout(120_000)
  const ws = new WebSocket(gateway.wsUrl)
  const created: Array<{ id: string; server_id?: string }> = []
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject)
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.t === 'READY') resolve()
      if (frame.t === 'MESSAGE_CREATE') created.push(frame.d)
    })
    ws.once('open', () => ws.send(JSON.stringify({ op: 2, d: { token } })))
  })

  try {
    const sent = await upload('anim.png', 'image/png', 'level-up.png')
    expect(sent.status).toBe(201)
    const part = await sent.json() as { type: string; path: string; fileType: string; mimeType: string }
    expect(part).toMatchObject({ type: 'file', fileType: 'image', mimeType: 'image/apng' })
    expect(part.path.startsWith(`c/${server.generalChannelId}/bridge/${botId}/`)).toBe(true)

    const posted = await api('POST', `/channels/${server.generalChannelId}/messages`, {
      content: [{ type: 'text', text: 'Alice reached level 5' }, part],
    })
    expect(posted.status).toBe(201)
    const message = await posted.json() as { id: string }
    const { data: stored } = await admin.from('messages').select('content').eq('id', message.id).single()
    expect(stored!.content.find((p: { type: string }) => p.type === 'file').path).toBe(part.path)

    await signIn(page, alice)
    await openChannel(page, server.id, server.generalChannelId)
    const row = messageList(page).locator('.message-item').filter({ hasText: 'Alice reached level 5' })
    const image = row.locator('img.content-image')
    await expect(image).toBeVisible({ timeout: 30000 })
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 30000 }).toBe(true)

    const photo = await upload('gps-upright.jpg', 'image/jpeg', 'photo.jpg')
    expect(photo.status).toBe(201)
    const photoPart = await photo.json() as { path: string; mimeType: string }
    expect(photoPart.mimeType).toBe('image/jpeg')
    const { data: blob, error } = await admin.storage.from('message_media').download(photoPart.path)
    if (error || !blob) throw new Error(`download: ${error?.message}`)
    const bytes = Buffer.from(await blob.arrayBuffer()).toString('latin1')
    for (const marker of GPS_MARKERS) expect(bytes).not.toContain(marker)

    // Alice's message reaches the bot with its server.
    const { data: own, error: sendError } = await admin
      .from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: alice.id, content: [{ type: 'text', text: 'thanks bot' }] })
      .select('id')
      .single()
    if (sendError || !own) throw new Error(`send: ${sendError?.message}`)
    await expect.poll(() => created.find((d) => d.id === own.id)?.server_id, { timeout: 20000 }).toBe(server.id)

    await setInstall({ attach_files: false })
    const refused = await upload('anim.png', 'image/png', 'nope.png')
    expect(refused.status).toBe(403)
    expect((await refused.json()).error).toBe('Missing permission: attach_files')
  } finally {
    await setInstall({ attach_files: true })
    ws.close()
  }
})
