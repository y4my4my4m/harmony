// Journey: photo details leave Harmony only when someone keeps them at that step.
//
//   drive kept  a photo kept with its details in Drive is posted and sent without them unless
//               kept again; the Drive file stays as it is
//   drive old   a Drive photo without an upload record (before 1.9.2) is read when attached and
//               sent without its details
//   bot         a bridge bot's Discord attachment, mirrored by the gateway, is stored without
//               them (the "Discord CDN" is a local HTTPS server reached through a CONNECT proxy,
//               NODE_USE_ENV_PROXY, with a test CA in NODE_EXTRA_CA_CERTS)
//   reload      a reload restores the chip and the choice; a stripped upload can no longer be
//               kept, a kept one is stripped from its own stored object
//
// Fixtures and byte checks: photoDetails.ts.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SpecUser,
} from './harness'
import { startBotGateway } from './botGateway'
import { KEEP, PHOTO, UPLOADED, expectStripped, jpegExif, markers, sendAttached, storedObject } from './photoDetails'

const admin = adminClient()
const users: SpecUser[] = []

async function user(tag: string): Promise<SpecUser> {
  const created = await createUser(admin, tag)
  users.push(created)
  return created
}

test.afterAll(async () => {
  for (const u of users) {
    await admin.from('photo_details_settings').delete().eq('user_id', u.id)
    await deleteUser(admin, u)
  }
})

const item = (page: Page, name: string) => page.getByTestId('file-preview-item').filter({ hasText: name })

async function download(bucket: string, objectPath: string): Promise<Buffer> {
  const { data, error } = await admin.storage.from(bucket).download(objectPath)
  if (error || !data) throw new Error(`download ${bucket}/${objectPath}: ${error?.message}`)
  return Buffer.from(await data.arrayBuffer())
}

async function driveRow(owner: SpecUser, name: string) {
  const { data, error } = await admin.from('drive_files').select('path, photo_details, photo_location')
    .eq('owner_id', owner.id).eq('name', name).single()
  if (error || !data) throw new Error(`drive file ${name}: ${error?.message}`)
  return data as { path: string; photo_details: string | null; photo_location: boolean | null }
}

/** `size`: the listed size, telling a Drive file from a stripped copy of the same name. */
async function attachFromDrive(page: Page, name: string, size?: string) {
  await page.getByTestId('composer-attach').click()
  await page.getByTestId('upload-menu-drive').click()
  const files = page.getByTestId('drive-picker').getByTestId('drive-picker-file').filter({ hasText: name })
  await (size ? files.filter({ hasText: size }) : files).click()
  await page.getByTestId('drive-picker-confirm').click()
}

test('a Drive photo kept with its details is posted and sent without them unless kept again', async ({ page }) => {
  test.setTimeout(240_000)
  const owner = await user('phdk')
  const server = await seedServer(admin, owner, `Drive kept ${owner.username}`)
  await signIn(page, owner)
  let original = ''

  await test.step('Drive keeps the photo with its details, and records that', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'harbour.jpg', mimeType: 'image/jpeg', buffer: PHOTO })
    const dialog = page.getByRole('dialog', { name: 'Photo and video details' })
    await dialog.getByRole('checkbox', { name: KEEP }).check()
    await dialog.getByRole('button', { name: 'Upload' }).click()
    await expect(page.getByTestId('drive-file').filter({ hasText: 'harbour.jpg' })).toBeVisible({ timeout: 30000 })
    const row = await driveRow(owner, 'harbour.jpg')
    expect(row).toMatchObject({ photo_details: 'kept', photo_location: true })
    original = row.path
    expect((await download('message_media', original)).equals(PHOTO)).toBe(true)
  })

  await test.step('a post from Drive goes up without the details', async () => {
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'New post' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a post' })
    await dialog.locator('.rich-text-editor').click()
    await page.keyboard.type(`from drive ${owner.username}`)
    await dialog.getByTestId('compose-from-drive').click()
    await page.getByTestId('drive-picker').getByTestId('drive-picker-file').filter({ hasText: 'harbour.jpg' }).click()
    await page.getByTestId('drive-picker-confirm').click()
    const media = dialog.locator('.media-preview-item').filter({ hasText: 'harbour.jpg' })
    await expect(media.getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 15000 })
    await expect(media.getByRole('checkbox', { name: KEEP })).not.toBeChecked()
    await dialog.getByTestId('compose-submit').click()
    await expect(dialog).toBeHidden({ timeout: 30000 })

    let posted: Array<{ url: string }> = []
    await expect.poll(async () => {
      const { data } = await admin.from('posts').select('media_attachments').eq('author_id', owner.id).maybeSingle()
      posted = (data?.media_attachments as typeof posted | null) ?? []
      return posted.length
    }, { timeout: 15000 }).toBe(1)
    expectStripped(await download('user_media', posted[0].url.replace(/^.*\/storage\/v1\/object\/public\/user_media\//, '')))
  })

  await test.step('kept again in a message, it is sent as the Drive file itself', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await attachFromDrive(page, 'harbour.jpg', '2 KB')
    const kept = item(page, 'harbour.jpg')
    await expect(kept.getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 15000 })
    await kept.getByRole('checkbox', { name: KEEP }).check()
    await expect(kept.getByTestId('photo-location-chip')).toHaveText('Includes location')
    await expect(kept).toContainText('From Drive', { timeout: 30000 })
    await sendAttached(page, `drive kept ${owner.username}`, 'harbour.jpg')
    const stored = await storedObject({ channel_id: server.generalChannelId })
    expect(stored.path).toBe(original)
    expect(stored.bytes.equals(PHOTO)).toBe(true)
  })

  await test.step('not kept, a message from Drive goes up as a stripped copy', async () => {
    await attachFromDrive(page, 'harbour.jpg', '2 KB')
    await expect(item(page, 'harbour.jpg').getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 15000 })
    await expect(item(page, 'harbour.jpg').getByRole('checkbox', { name: KEEP })).not.toBeChecked()
    await sendAttached(page, `drive copy ${owner.username}`, 'harbour.jpg')
    const stored = await storedObject({ channel_id: server.generalChannelId })
    expect(stored.path).not.toBe(original)
    expectStripped(stored.bytes)
    // The Drive file stays as it is.
    expect((await download('message_media', original)).equals(PHOTO)).toBe(true)
  })
})

test('a Drive photo from before 1.9.2 is read when attached and sent without its details', async ({ page }) => {
  test.setTimeout(150_000)
  const owner = await user('phdo')
  const server = await seedServer(admin, owner, `Drive old ${owner.username}`)
  const db = await userClient(owner)
  const { error } = await db.storage.from('message_media').upload(`u/${owner.id}/old.jpg`, PHOTO, {
    contentType: 'image/jpeg', metadata: { name: 'old.jpg' },
  })
  if (error) throw new Error(`old upload: ${error.message}`)
  await expect.poll(async () => (await driveRow(owner, 'old.jpg')).photo_details).toBeNull()

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await attachFromDrive(page, 'old.jpg')
  await expect(item(page, 'old.jpg').getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 20000 })
  await sendAttached(page, `old drive photo ${owner.username}`, 'old.jpg')
  expectStripped((await storedObject({ channel_id: server.generalChannelId })).bytes)
})

/** A local HTTPS "cdn.discordapp.com" behind a CONNECT proxy, with its own CA. */
async function fakeDiscordCdn(body: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-cdn-'))
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Harmony E2E CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'cdn.key', '-out', 'cdn.csr', '-subj', '/CN=cdn.discordapp.com'])
  fs.writeFileSync(path.join(dir, 'san.cnf'), 'subjectAltName=DNS:cdn.discordapp.com\n')
  run(['x509', '-req', '-in', 'cdn.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cdn.pem', '-days', '1', '-extfile', 'san.cnf'])

  const requests: string[] = []
  const cdn = https.createServer({ key: fs.readFileSync(path.join(dir, 'cdn.key')), cert: fs.readFileSync(path.join(dir, 'cdn.pem')) },
    (req, res) => {
      requests.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length })
      res.end(body)
    })
  await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const tunnels: string[] = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url ?? '')
    const upstream = net.connect((cdn.address() as net.AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    env: {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      NO_PROXY: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem'),
    },
    requests,
    tunnels,
    async close() {
      proxy.closeAllConnections()
      cdn.closeAllConnections()
      await new Promise((resolve) => proxy.close(resolve))
      await new Promise((resolve) => cdn.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a bridged Discord photo is stored without its details', async () => {
  test.setTimeout(150_000)
  const owner = await user('phb')
  const server = await seedServer(admin, owner, `Bridge photo ${owner.username}`)
  const db = await userClient(owner)
  const { data: bot, error } = await db.rpc('create_bot', {
    p_username: `bridge${owner.username.slice(-8)}`, p_display_name: 'Discord Bridge', p_bio: 'Relays messages',
    p_bot_type: 'bridge', p_is_public: false,
  })
  if (error || !bot?.token) throw new Error(`create_bot: ${error?.message}`)
  const { error: installError } = await admin.from('bot_server_permissions').insert({
    bot_id: bot.bot.id, server_id: server.id, installed_by: owner.id, is_active: true, read_messages: true, send_messages: true,
  })
  if (installError) throw new Error(`install: ${installError.message}`)

  const { data: previous } = await admin.from('instance_config').select('config_key, config_value').eq('config_key', 'bridge_attachment_mode').maybeSingle()
  const { error: modeError } = await admin.from('instance_config')
    .upsert({ config_key: 'bridge_attachment_mode', config_value: 'mirror' }, { onConflict: 'config_key' })
  if (modeError) throw new Error(`bridge_attachment_mode: ${modeError.message}`)

  const cdn = await fakeDiscordCdn(PHOTO)
  const gateway = await startBotGateway(cdn.env)
  try {
    const response = await fetch(`${gateway.url}/api/v1/channels/${server.generalChannelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${bot.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [
        { type: 'text', text: 'from discord' },
        { type: 'file', fileType: 'image', fileName: 'IMG_0420.jpg', url: 'https://cdn.discordapp.com/attachments/1/2/IMG_0420.jpg?ex=1' },
      ] }),
    })
    expect(response.status, await response.clone().text()).toBe(201)
    expect(cdn.tunnels).toEqual(['cdn.discordapp.com:443'])
    expect(cdn.requests).toEqual(['/attachments/1/2/IMG_0420.jpg?ex=1'])

    const stored = await storedObject({ channel_id: server.generalChannelId })
    expect(stored.path).toMatch(new RegExp(`^c/${server.generalChannelId}/bridge/${bot.bot.id}/`))
    expectStripped(stored.bytes)
  } finally {
    await gateway.stop()
    await cdn.close()
    if (previous) await admin.from('instance_config').upsert(previous, { onConflict: 'config_key' })
    else await admin.from('instance_config').delete().eq('config_key', 'bridge_attachment_mode')
  }
})

test('a reload brings back each photo\'s chip and choice', async ({ page }) => {
  test.setTimeout(180_000)
  const owner = await user('phr')
  const server = await seedServer(admin, owner, `Photo reload ${owner.username}`)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await page.getByTestId('composer-file-input').setInputFiles([
    { name: 'IMG_A.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
    { name: 'IMG_B.jpg', mimeType: 'image/jpeg', buffer: PHOTO },
  ])
  await item(page, 'IMG_B.jpg').getByRole('checkbox', { name: KEEP }).check()
  for (const name of ['IMG_A.jpg', 'IMG_B.jpg']) await expect(item(page, name)).toContainText(UPLOADED, { timeout: 30000 })
  // Drafts are saved 500 ms after a change.
  await page.waitForTimeout(1500)

  await page.reload()
  await dismissAnnouncements(page)
  const a = item(page, 'IMG_A.jpg')
  const b = item(page, 'IMG_B.jpg')
  await expect(a.getByTestId('photo-location-chip')).toHaveText('Location removed', { timeout: 30000 })
  await expect(a.getByRole('checkbox', { name: KEEP })).toBeDisabled()
  await expect(a.getByTestId('photo-details-gone')).toBeVisible()
  await expect(b.getByTestId('photo-location-chip')).toHaveText('Includes location')
  await expect(b.getByRole('checkbox', { name: KEEP })).toBeChecked()
  await expect(b.getByRole('checkbox', { name: KEEP })).toBeEnabled()

  await test.step('the kept photo, unticked after the reload, is stripped from its stored copy', async () => {
    const before = await storedPaths(owner)
    await b.getByRole('checkbox', { name: KEEP }).uncheck()
    await expect(b.getByTestId('photo-location-chip')).toHaveText('Location removed')
    await expect(b).toContainText(UPLOADED, { timeout: 30000 })
    await sendAttached(page, `restored ${owner.username}`, 'IMG_B.jpg')
    const { data: row } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
      .order('created_at', { ascending: false }).limit(1).single()
    const files = (row!.content as Array<{ type: string; path?: string }>).filter((p) => p.type === 'file')
    expect(files).toHaveLength(2)
    for (const file of files) expectStripped(await download('message_media', file.path!))
    // The kept copy made before the reload is gone.
    await expect.poll(async () => (await storedPaths(owner)).filter((p) => before.includes(p)).length).toBe(before.length - 1)
  })
  expect(markers(PHOTO).length).toBe(6)
  expect(jpegExif(PHOTO)).toEqual([{ orientation: 6, gps: true }])
})

/** message_media objects of `owner` in Drive. */
async function storedPaths(owner: SpecUser): Promise<string[]> {
  const { data } = await admin.from('drive_files').select('path').eq('owner_id', owner.id).neq('state', 'gone')
  return (data ?? []).map((row) => row.path as string)
}
