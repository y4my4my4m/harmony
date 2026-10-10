// Journey: a server invite link pasted into a chat app unfurls into a card. A link-preview
// crawler fetching /invite/<code> gets the federation backend's OpenGraph page: server name,
// member and online counts, description, banner, embed colour, noindex. A dead invite gets a
// card naming no server. People get the app: the invite page, and in chat the invite card with
// the online count.
//
// The reverse proxy's User-Agent routing is not part of this stack: crawlers' requests go to
// the backend (e2e/specs/backend.ts) directly. scripts/check-nginx-template.sh covers the
// routing in dev/nginx-harmony.template.conf.
//
// The stack runs no realtime and no presence sweep. Presence is a heartbeat sent through
// presence_heartbeat with the member's own session, as the client sends it: one member online,
// one invisible, the owner never signed in.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { INSTANCE_DOMAIN, startBackend, type Backend } from './backend'

const DISCORDBOT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const DESCRIPTION = 'Evening voice chats and   a weekly game night.'

const admin = adminClient()
let owner: SpecUser
let online: SpecUser
let invisible: SpecUser
let viewer: SpecUser
let server: SeededServer
let viewerServer: SeededServer
let backend: Backend
const codes = { valid: '', revoked: '', expired: '', spent: '', unknown: '' }

function code(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function heartbeat(user: SpecUser, status: 1 | 4): Promise<void> {
  const client = await userClient(user)
  const { error } = await client.rpc('presence_heartbeat', { p_device_id: 'e2e-invite', p_status: status, p_is_mobile: false })
  if (error) throw new Error(`${user.username} heartbeat: ${error.message}`)
}

function meta(html: string, key: string): string | undefined {
  const escaped = key.replace(/[:.]/g, '\\$&')
  return new RegExp(`<meta (?:property|name)="${escaped}" content="([^"]*)">`).exec(html)?.[1]
}

const crawl = (path: string) => fetch(`${backend.url}${path}`, { headers: { 'User-Agent': DISCORDBOT } })

// One fixture and one backend for every test in the file.
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  owner = await createUser(admin, 'ilpo')
  online = await createUser(admin, 'ilpa')
  invisible = await createUser(admin, 'ilpi')
  viewer = await createUser(admin, 'ilpv')
  server = await seedServer(admin, owner, `Lounge ${owner.username}`)
  viewerServer = await seedServer(admin, viewer, `Elsewhere ${viewer.username}`)

  const { error: serverError } = await admin
    .from('servers')
    .update({ description: DESCRIPTION, icon: `${server.id}/icon.png`, banner: `${server.id}/banner.png` })
    .eq('id', server.id)
  if (serverError) throw new Error(`server card: ${serverError.message}`)

  await addMember(admin, online, server.id)
  await addMember(admin, invisible, server.id)
  await heartbeat(online, 1)
  await heartbeat(invisible, 4)

  for (const key of Object.keys(codes) as Array<keyof typeof codes>) codes[key] = code()
  const { error: inviteError } = await admin.from('invites').insert([
    { code: codes.valid, server_id: server.id, created_by: owner.id, max_uses: 0 },
    { code: codes.revoked, server_id: server.id, created_by: owner.id, used: true },
    { code: codes.expired, server_id: server.id, created_by: owner.id, expires_at: new Date(Date.now() - 60_000).toISOString() },
    { code: codes.spent, server_id: server.id, created_by: owner.id, max_uses: 1, uses: 1 },
  ])
  if (inviteError) throw new Error(`invites: ${inviteError.message}`)

  backend = await startBackend()
})

test.afterAll(async () => {
  await backend?.stop()
  for (const user of [owner, online, invisible, viewer]) await deleteUser(admin, user)
})

test('a crawler unfurls a valid invite into the server card', async () => {
  const res = await crawl(`/invite/${codes.valid}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('public, max-age=300')
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(res.headers.get('vary')).toMatch(/User-Agent/)
  const html = await res.text()

  expect(meta(html, 'og:title')).toBe(server.name)
  expect(meta(html, 'og:site_name')).toBe('Harmony')
  expect(meta(html, 'og:description')).toBe('3 members · 1 online — Evening voice chats and a weekly game night.')
  expect(meta(html, 'og:url')).toBe(`https://${INSTANCE_DOMAIN}/invite/${codes.valid}`)
  expect(meta(html, 'og:image')).toBe(
    `${process.env.E2E_SUPABASE_URL}/storage/v1/object/public/server_banners/${server.id}/banner.png`)
  expect(meta(html, 'twitter:card')).toBe('summary_large_image')
  expect(meta(html, 'theme-color')).toBe('#0EA5E9')
  expect(meta(html, 'robots')).toBe('noindex, nofollow')
  expect(html).toContain('type="application/json+oembed"')
  expect(html).not.toMatch(/<script\b/i)
})

test('a crawler gets a card naming no server for a dead invite', async () => {
  for (const dead of [codes.revoked, codes.expired, codes.spent, codes.unknown]) {
    const res = await crawl(`/invite/${dead}`)
    expect(res.status, dead).toBe(200)
    expect(res.headers.get('cache-control'), dead).toBe('public, max-age=60')
    const html = await res.text()
    expect(meta(html, 'og:title'), dead).toBe('Invite invalid or expired')
    expect(meta(html, 'robots'), dead).toBe('noindex, nofollow')
    expect(html, dead).not.toContain(server.name)
    expect(html, dead).not.toContain('game night')
    expect(html, dead).not.toContain('server_banners')
  }
})

test('oEmbed names the invite and the instance', async () => {
  const url = encodeURIComponent(`https://${INSTANCE_DOMAIN}/invite/${codes.valid}`)
  const res = await crawl(`/oembed?url=${url}&format=json`)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({
    type: 'link',
    title: server.name,
    author_name: "You've been invited to join a server",
    provider_name: 'Harmony',
  })

  const dead = encodeURIComponent(`https://${INSTANCE_DOMAIN}/invite/${codes.revoked}`)
  expect((await crawl(`/oembed?url=${dead}&format=json`)).status).toBe(404)
})

test('in the app the invite card shows the online count and the link opens the invite page', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const link = `${baseURL}/invite/${codes.valid}`
  const { error } = await (await userClient(viewer)).from('messages').insert({
    channel_id: viewerServer.generalChannelId,
    user_id: viewer.id,
    content: [{ type: 'text', text: 'come hang out ' }, { type: 'url', url: link, preview: true }],
  })
  if (error) throw new Error(`message: ${error.message}`)

  const context = await browser.newContext()
  const page = await context.newPage()

  await test.step('the invite card in chat shows members and who is online', async () => {
    await signIn(page, viewer)
    await openChannel(page, viewerServer.id, viewerServer.generalChannelId)
    const card = messageList(page).locator('.server-invite-card')
    await expect(card.locator('.server-name')).toHaveText(server.name, { timeout: 30000 })
    await expect(card.locator('.online-count')).toHaveText('1 online')
    await expect(card.locator('.member-count')).toContainText('3 members')
  })

  await test.step('a browser opening the link lands on the invite page', async () => {
    await page.goto(link)
    await dismissAnnouncements(page)
    await expect(page.locator('.invite-card__title')).toHaveText(server.name, { timeout: 30000 })
  })

  await context.close()
})
