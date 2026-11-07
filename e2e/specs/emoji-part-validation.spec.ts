// Journey: emoji parts a modified client writes, and remote emoji copied onto this instance
// (20261107100001_emoji_lifecycle, federation-backend routes/adminEmojis.ts).
//
// A member's session writes, as a modified client would, a message whose emoji part pairs a
// real emoji's id with a tracker image, one naming another member's personal emoji, and a
// url-only part: the stored message holds the emoji's own image and :name: text for the rest,
// and the page never requests the tracker. A malformed part is refused (22023).
//
// An admin imports a remote emoji from Admin › Emojis › Not imported: the backend downloads it
// from the remote host into the emojis bucket and the new instance emoji's url is that object,
// with the remote url kept in imported_from. A hotlinked instance emoji is re-hosted the same way.
// The remote host listens on the gateway of a Docker bridge on E2E_PEER_SUBNET (default
// 198.51.100.0/24): the backend refuses loopback and private addresses (utils/ssrfProtection.ts).

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import { startBackend, type Backend } from './backend'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

// 16x16 opaque PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR42mP8z8AARMQBxlGF1FUIAMJVAf8zYy5CAAAAAElFTkSuQmCC',
  'base64',
)
const TRACKER = 'https://tracker.e2e.test'
const INSTANCE_FOLDER = '00000000-0000-0000-0000-000000000000'

const admin = adminClient()
const tag = crypto.randomUUID().slice(0, 8)
let owner: SpecUser
let member: SpecUser
let other: SpecUser
let staff: SpecUser
let server: SeededServer
let backend: Backend
let remote: RemoteHost
let serverEmoji: { id: string; name: string; url: string }
let otherEmojiId: string
let cacheId: string
let hotlinkedId: string
const madeObjects: string[] = []

interface RemoteHost {
  origin: string
  requests: string[]
  stop(): Promise<void>
}

function hostHolds(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, ip, () => probe.close(() => resolve(true)))
  })
}

/** Plain http on the gateway of a Docker bridge network: an address the backend may fetch. */
async function startRemoteHost(): Promise<RemoteHost> {
  const subnet = process.env.E2E_PEER_SUBNET ?? '198.51.100.0/24'
  const ip = `${subnet.split('/')[0].split('.').slice(0, 3).join('.')}.1`
  const network = `${process.env.E2E_PROJECT ?? 'hme2e'}-emoji-remote`
  let created = false
  if (!(await hostHolds(ip))) {
    try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* absent */ }
    execFileSync('docker', ['network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', ip, network], { stdio: 'ignore' })
    created = true
    for (let i = 0; i < 50 && !(await hostHolds(ip)); i++) await new Promise((r) => setTimeout(r, 100))
    if (!(await hostHolds(ip))) throw new Error(`docker network ${network} gave the host no ${ip}`)
  }
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url?.endsWith('.png')) res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, ip, resolve))
  return {
    origin: `http://${ip}:${(server.address() as { port: number }).port}`,
    requests,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (created) {
        try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* gone */ }
      }
    },
  }
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'epvown')
  member = await createUser(admin, 'epvmem')
  other = await createUser(admin, 'epvoth')
  staff = await createUser(admin, 'epvadm')
  const { error: adminError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (adminError) throw new Error(`admin: ${adminError.message}`)
  server = await seedServer(admin, owner, `Parts ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)

  const asOwner = await userClient(owner)
  const path = `${server.id}/${owner.id}/${crypto.randomUUID()}.png`
  const { error: uploadError } = await asOwner.storage.from('emojis').upload(path, PNG, { contentType: 'image/png' })
  if (uploadError) throw new Error(`upload: ${uploadError.message}`)
  madeObjects.push(path)
  const url = asOwner.storage.from('emojis').getPublicUrl(path).data.publicUrl
  const { data, error } = await asOwner.rpc('create_server_emoji', { p_server_id: server.id, p_name: `real${tag}`, p_path: path, p_url: url })
  if (error || !data) throw new Error(`create_server_emoji: ${error?.message}`)
  serverEmoji = { id: data.id, name: data.name, url: data.url }

  const { data: personal, error: personalError } = await admin.from('emojis')
    .insert({ name: `theirs${tag}`, url: `${TRACKER}/theirs.png`, scope: 'user', uploader: other.id })
    .select('id').single()
  if (personalError || !personal) throw new Error(`personal: ${personalError?.message}`)
  otherEmojiId = personal.id

  remote = await startRemoteHost()
  const { data: cached, error: cacheError } = await admin.from('remote_emojis_cache')
    .insert({
      shortcode: `blob${tag}`, origin_domain: `remote-${tag}.e2e.test`,
      full_code: `:blob${tag}@remote-${tag}.e2e.test:`, url: `${remote.origin}/emoji/blob${tag}.png`, usage_count: 999999,
    })
    .select('id').single()
  if (cacheError || !cached) throw new Error(`remote cache: ${cacheError?.message}`)
  cacheId = cached.id
  const { data: hot, error: hotError } = await admin.from('emojis')
    .insert({ name: `hot${tag}`, url: `${remote.origin}/emoji/hot${tag}.png`, scope: 'instance' })
    .select('id').single()
  if (hotError || !hot) throw new Error(`hotlinked: ${hotError?.message}`)
  hotlinkedId = hot.id

  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  await remote?.stop()
  const { data: rows } = await admin.from('emojis').select('id, url').in('name', [`real${tag}`, `theirs${tag}`, `blob${tag}`, `hot${tag}`])
  for (const row of rows ?? []) {
    const p = (row.url as string).split('/storage/v1/object/public/emojis/')[1]
    if (p) madeObjects.push(p)
  }
  await admin.from('emojis').delete().in('id', (rows ?? []).map((r) => r.id))
  await admin.from('remote_emojis_cache').delete().eq('id', cacheId ?? '')
  if (madeObjects.length) await admin.storage.from('emojis').remove([...new Set(madeObjects)])
  await deleteUser(admin, member)
  await deleteUser(admin, other)
  await deleteUser(admin, owner)
  await deleteUser(admin, staff)
})

test('emoji parts a modified client writes are bound to emojis the sender may use', async ({ page }) => {
  test.setTimeout(180_000)
  let trackerRequests = 0
  await page.route(`${TRACKER}/**`, (route) => {
    trackerRequests++
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })

  const asMember = await userClient(member)
  const marker = `forged ${tag}`
  const { data: sent, error } = await asMember.from('messages')
    .insert({
      channel_id: server.generalChannelId, user_id: member.id,
      content: [
        { type: 'text', text: `${marker} ` },
        { type: 'emoji', emoji: { id: serverEmoji.id, name: serverEmoji.name, url: `${TRACKER}/swap.png` } },
        { type: 'emoji', emoji: { id: otherEmojiId, name: `theirs${tag}`, url: `${TRACKER}/theirs.png` } },
        { type: 'emoji', emoji: { name: `track${tag}`, url: `${TRACKER}/pixel.png` } },
      ],
    })
    .select('id, content').single()
  expect(error).toBeNull()
  expect(sent!.content).toEqual([
    { type: 'text', text: `${marker} ` },
    { type: 'emoji', emoji: { id: serverEmoji.id, name: serverEmoji.name, url: serverEmoji.url, server_id: server.id } },
    { type: 'text', text: `:theirs${tag}:` },
    { type: 'text', text: `:track${tag}:` },
  ])

  const malformed = await asMember.from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: member.id, content: [{ type: 'emoji', emoji: { name: 'two words', url: `${TRACKER}/x.png` } }] })
  expect(malformed.error?.code).toBe('22023')
  const notObject = await asMember.from('posts')
    .insert({ author_id: member.id, visibility: 'public', is_local: true, content: [{ type: 'emoji', emoji: 'blob' }] })
  expect(notObject.error?.code).toBe('22023')

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const row = page.locator(`[data-testid="message-list"] .message-item[data-message-id="${sent!.id}"]`)
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).toContainText(`:theirs${tag}:`)
  await expect(row).toContainText(`:track${tag}:`)
  await expect.poll(() => row.locator(`img[alt=":${serverEmoji.name}:"]`).evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30000 })
    .toBeGreaterThan(0)
  expect(trackerRequests).toBe(0)
})

async function openAdminEmojis(page: Page) {
  await signIn(page, staff)
  await backend.route(page)
  await page.goto('/admin?tab=emojis')
  const library = page.getByTestId('admin-emoji-library')
  await expect(library).toBeVisible({ timeout: 30000 })
  return library
}

test('an import and a re-host copy the remote image into this instance\'s storage', async ({ page }) => {
  test.setTimeout(180_000)
  const library = await openAdminEmojis(page)

  await test.step('import from Not imported', async () => {
    await library.getByTestId('admin-emoji-kind-not_imported').click()
    await library.getByTestId('admin-emoji-search').fill(`blob${tag}`)
    const row = library.locator(`[data-testid="admin-emoji-row"][data-emoji-id="${cacheId}"]`)
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.getByRole('button', { name: `Import :blob${tag}:` }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(row).toHaveCount(0, { timeout: 30000 })

    const { data: imported } = await admin.from('emojis').select('url, imported_from, scope, domain').eq('name', `blob${tag}`).single()
    expect(imported).toMatchObject({ scope: 'instance', domain: null, imported_from: `${remote.origin}/emoji/blob${tag}.png` })
    expect(imported!.url).toMatch(new RegExp(`/storage/v1/object/public/emojis/${INSTANCE_FOLDER}/[0-9a-f-]{36}\\.png$`))
    expect(remote.requests).toContain(`/emoji/blob${tag}.png`)
    const object = imported!.url.split('/storage/v1/object/public/emojis/')[1]
    const { data: listed } = await admin.storage.from('emojis').list(INSTANCE_FOLDER, { search: object.split('/')[1] })
    expect(listed?.map((o) => o.name)).toEqual([object.split('/')[1]])
    const { data: cache } = await admin.from('remote_emojis_cache').select('imported_as').eq('id', cacheId).single()
    expect(cache?.imported_as).not.toBeNull()
  })

  await test.step('re-host a hotlinked instance emoji', async () => {
    await library.getByTestId('admin-emoji-kind-instance').click()
    await library.getByTestId('admin-emoji-search').fill(`hot${tag}`)
    const row = library.locator(`[data-testid="admin-emoji-row"][data-emoji-id="${hotlinkedId}"]`)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row.locator('.badge.hotlinked')).toBeVisible()
    await row.getByRole('button', { name: `Re-host :hot${tag}:` }).click()
    await expect(row.locator('.badge.hotlinked')).toHaveCount(0, { timeout: 30000 })

    const { data: rehosted } = await admin.from('emojis').select('url, imported_from').eq('id', hotlinkedId).single()
    expect(rehosted!.imported_from).toBe(`${remote.origin}/emoji/hot${tag}.png`)
    expect(rehosted!.url).toMatch(new RegExp(`/storage/v1/object/public/emojis/${INSTANCE_FOLDER}/[0-9a-f-]{36}\\.png$`))
  })
})
