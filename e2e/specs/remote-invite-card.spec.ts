// Journey: an invite link to a server on another Harmony instance renders as the native invite
// card, drawn from the card the federation backend stored for the link (provider
// harmony-remote-invite, services/remoteInvitePreview.ts): the server's icon, name, online and
// member counts and description, Join server, and under the button the hosting instance's
// icon and name. The card reads its counts again through this instance's backend; Join opens
// the cross-instance join dialog for the link, and a viewer who has the server's copy goes to
// it. A dead invite renders the invalid state. An invite link of this instance still renders
// the local card.
//
// This stack runs no federation backend: the cards are written through update_message_embeds
// as the link-preview worker writes them, and /remote-invite, /invites/resolve and the copy's
// status and sync are answered by page.route(). e2e/federation/cases/remoteInviteCard.ts covers
// the backend that writes them.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  adminClient,
  addMember,
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

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let viewer: SpecUser
let localOwner: SpecUser
let viewerServer: SeededServer
let localServer: SeededServer

const HOST = 'peer-harmony.example'
const copy = { id: crypto.randomUUID(), name: 'Copied Lounge', channelId: crypto.randomUUID() }
const copyGroup = `https://${HOST}/servers/${copy.id}`
const joinGroup = `https://${HOST}/servers/${crypto.randomUUID()}`
const links = {
  join: `https://${HOST}/invite/JOIN${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
  dead: `https://${HOST}/invite/DEAD${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
  copy: `https://${HOST}/invite/COPY${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
}
let localCode = ''

// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

const instance = { name: 'Peer Harmony', icon: `https://${HOST}/instance-icon.png` }

function card(code: string, server: Record<string, unknown>) {
  return {
    status: 'valid', code, domain: HOST, instance,
    server: { description: null, icon: null, memberCount: null, onlineCount: null, id: null, ...server },
  }
}

const cards = {
  join: card(links.join.split('/').pop()!, {
    name: 'Timbre', description: 'Alternative Har.mony client which looks like the original',
    icon: `https://${HOST}/server-icon.png`, memberCount: 6, onlineCount: 2, id: joinGroup,
  }),
  dead: { status: 'invalid', code: links.dead.split('/').pop()!, domain: HOST, instance },
  copy: card(links.copy.split('/').pop()!, { name: copy.name, memberCount: 4, onlineCount: 1, id: copyGroup }),
}

/** A message of the viewer naming `url`; its card is then stored as the link-preview worker stores it. */
async function linkMessage(text: string, url: string, remoteInvite?: unknown): Promise<string> {
  const client = await userClient(viewer)
  const { data } = await must(`message ${text}`, client.from('messages').insert({
    channel_id: viewerServer.generalChannelId,
    user_id: viewer.id,
    content: [{ type: 'text', text }, { type: 'url', url, preview: true }],
  }).select('id').single())
  const id = (data as { id: string }).id
  if (remoteInvite) {
    await must(`card ${text}`, admin.rpc('update_message_embeds', {
      p_message_id: id,
      p_embeds: {
        [url]: {
          cacheKey: `generic:${url}`, url, normalizedUrl: url, provider: 'harmony-remote-invite',
          siteName: instance.name, remoteInvite,
          fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      },
    }))
  }
  return id
}

const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text })
const remoteCard = (page: Page, text: string) => row(page, text).locator('[data-testid="remote-invite-card"]')

test.beforeAll(async () => {
  viewer = await createUser(admin, 'rinv')
  localOwner = await createUser(admin, 'rino')
  viewerServer = await seedServer(admin, viewer, `Home ${viewer.username}`)
  localServer = await seedServer(admin, localOwner, `Lounge ${localOwner.username}`)

  localCode = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join('')
  await must('local invite', admin.from('invites').insert({ code: localCode, server_id: localServer.id, created_by: localOwner.id, max_uses: 0 }))

  // The viewer's copy of a server hosted on the peer, as the federation backend writes one on join.
  await must('copy', admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: viewer.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: copyGroup, federation_inbox_url: `${copyGroup}/inbox`, federation_domain: HOST,
  }))
  await admin.from('channels').delete().eq('server_id', copy.id)
  await must('copy channel', admin.from('channels').insert({
    id: copy.channelId, server_id: copy.id, name: 'general', type: 0, order: 0, is_remote: true, ap_id: `${copyGroup}/channels/${copy.channelId}`,
  }))
  await addMember(admin, viewer, copy.id)

  await linkMessage('join timbre over there', links.join, cards.join)
  await linkMessage('this invite died', links.dead, cards.dead)
  await linkMessage('the lounge I am in', links.copy, cards.copy)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  await deleteUser(admin, viewer)
  await deleteUser(admin, localOwner)
})

test('an invite to a server on another Harmony instance renders as the invite card', async ({ page, baseURL }) => {
  test.setTimeout(150_000)
  const localLink = `${baseURL}/invite/${localCode}`
  await linkMessage('our own lounge', localLink)

  const refreshes: { url: string | null; auth: string | undefined }[] = []
  await page.route('**/remote-invite?*', (route) => {
    const asked = new URL(route.request().url()).searchParams.get('url')
    refreshes.push({ url: asked, auth: route.request().headers().authorization })
    if (asked === links.join) {
      return route.fulfill({ json: { invite: { ...cards.join, server: { ...cards.join.server, memberCount: 7, onlineCount: 3 } } } })
    }
    return route.fulfill({ status: 502, json: { code: 'unreachable' } })
  })
  const imageReferrers: (string | undefined)[] = []
  await page.route(`https://${HOST}/*.png`, (route) => {
    imageReferrers.push(route.request().headers().referer)
    return route.fulfill({ body: PNG, contentType: 'image/png' })
  })
  await page.route('**/invites/resolve', (route) => route.fulfill({ status: 404, json: { error: 'Invite not found or expired' } }))
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route('**/servers/*/sync', (route) => route.fulfill({ json: { success: true, message: 'Server synced' } }))

  await signIn(page, viewer)
  await openChannel(page, viewerServer.id, viewerServer.generalChannelId)

  await test.step('the card shows the server, its counts as the host answers now, and its instance under the button', async () => {
    const timbre = remoteCard(page, 'join timbre over there')
    await expect(timbre).toBeVisible({ timeout: 30000 })
    await expect(timbre).toHaveAttribute('aria-label', 'Invite to Timbre')
    await expect(timbre.locator('.server-name')).toHaveText('Timbre')
    await expect(timbre.locator('.online-count')).toHaveText('3 online')
    await expect(timbre.locator('.member-count')).toHaveText('7 members')
    await expect(timbre.locator('.server-description')).toHaveText('Alternative Har.mony client which looks like the original')
    await expect(timbre.locator('.server-image')).toHaveAttribute('src', `https://${HOST}/server-icon.png`)
    await expect.poll(() => timbre.locator('.server-image').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
    await expect(timbre.getByRole('button', { name: 'Join server' })).toBeVisible()

    const hosted = timbre.locator('.server-invite-card__actions [data-testid="remote-invite-instance"]')
    await expect(hosted.locator('.remote-invite__instance-name')).toHaveText('Peer Harmony')
    await expect(hosted.locator('.sr-only')).toHaveText('Hosted on Peer Harmony')
    await expect(hosted.locator('img')).toHaveAttribute('src', instance.icon)
    await expect.poll(() => hosted.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
    const button = await timbre.getByRole('button', { name: 'Join server' }).boundingBox()
    const footer = await hosted.boundingBox()
    expect(footer!.y).toBeGreaterThanOrEqual(button!.y + button!.height)

    expect(imageReferrers.length).toBeGreaterThan(0)
    expect(imageReferrers.every((r) => r === undefined)).toBe(true)
  })

  await test.step('the counts are read through this instance as the signed-in viewer; a dead invite is not asked', async () => {
    await expect.poll(() => refreshes.filter((r) => r.url === links.join).length).toBeGreaterThan(0)
    expect(refreshes.find((r) => r.url === links.join)?.auth).toMatch(/^Bearer \S+/)
    expect(refreshes.some((r) => r.url === links.dead)).toBe(false)
  })

  await test.step('a card the host does not answer again keeps the stored counts', async () => {
    const lounge = remoteCard(page, 'the lounge I am in')
    await expect(lounge.locator('.server-name')).toHaveText(copy.name)
    await expect(lounge.locator('.online-count')).toHaveText('1 online')
    await expect(lounge.locator('.member-count')).toHaveText('4 members')
    // No icon: the monogram, as the native card draws one.
    await expect(lounge.locator('.server-image')).toHaveAttribute('src', /^data:image\/svg\+xml/)
  })

  await test.step('a dead invite renders the invalid state', async () => {
    const dead = remoteCard(page, 'this invite died')
    await expect(dead).toHaveAttribute('data-status', 'invalid')
    await expect(dead.locator('.error-title')).toHaveText('Invalid invite')
    await expect(dead.locator('.error-message')).toHaveText('Invite not found or has expired')
    await expect(dead.getByRole('button')).toHaveCount(0)
  })

  await test.step('an invite of this instance renders the local card', async () => {
    const local = row(page, 'our own lounge').locator('.server-invite-card')
    await expect(local.locator('.server-name')).toHaveText(localServer.name, { timeout: 30000 })
    await expect(local.locator('.member-count')).toContainText('1 member')
    await expect(local.getByRole('button', { name: 'Join server' })).toBeVisible()
    await expect(row(page, 'our own lounge').locator('[data-testid="remote-invite-card"]')).toHaveCount(0)
  })

  await test.step('Join server opens the cross-instance join dialog for the link', async () => {
    await remoteCard(page, 'join timbre over there').getByRole('button', { name: 'Join server' }).click()
    const dialog = page.getByRole('dialog', { name: 'Join remote server' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('#server-url')).toHaveValue(links.join)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
  })

  await test.step('a viewer who has the copy goes to it', async () => {
    const lounge = remoteCard(page, 'the lounge I am in')
    await expect(lounge.getByRole('button', { name: 'Join server' })).toHaveCount(0)
    await lounge.getByRole('button', { name: 'Go to server' }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${copy.id}/${copy.channelId}$`), { timeout: 30000 })
  })
})
