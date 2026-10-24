// Journey: in a copy of a server on another instance, a message its host's bot, webhook or
// Discord bridge posted reads under that author's name and picture with its badge, never as
// "Deleted User" or a member's message. The host's Group sends such a message with the author
// in harmony:author; the federation backend stores it with no profile and no bot, the author in
// metadata.remote_author (activitypub/groupAuthor.ts). This stack has no federation backend: the
// rows are written here as the backend writes them.

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, messageList, openChannel, signIn, type SpecUser } from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let member: SpecUser

const host = 'bots.example'
const hostOwner = { id: crypto.randomUUID(), username: `rbh${Date.now().toString(36)}`, displayName: 'Host owner' }
const remote = { id: crypto.randomUUID(), name: 'Remote Workshop', channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${remote.id}`
const hookIcon = `https://${host}/storage/v1/object/public/avatars/deployer.png`
// 1x1 PNG: the Avatar shows the default picture for an image that fails to load.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

/** A row as the federation backend stores one of the Group's Notes. */
function cached(text: string, minutesAgo: number, metadata: Record<string, unknown>, author: Record<string, unknown> = {}) {
  const id = crypto.randomUUID()
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id, channel_id: remote.channel, content: [{ type: 'text', text }], created_at: at, updated_at: at,
    federation_status: 'skipped', ...author,
    metadata: { ap_id: `https://${host}/messages/${id}`, is_remote: true, federated: true, ...metadata },
  }
}

test.beforeAll(async () => {
  member = await createUser(admin, 'rbm')
  await must('host owner', admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: hostOwner.displayName, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  }))
  await must('remote server', admin.from('servers').insert({
    id: remote.id, name: remote.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', remote.id)
  await must('remote channel', admin.from('channels').insert({
    id: remote.channel, server_id: remote.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${remote.channel}`,
  }))
  await must('remote membership', admin.from('user_servers').upsert(
    { server_id: remote.id, user_id: member.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  ))
  const hook = { kind: 'webhook', id: crypto.randomUUID(), name: 'RT Deployer', avatar_url: hookIcon }
  await must('cached rows', admin.from('messages').insert([
    cached('hello from the host owner', 6, {}, { user_id: hostOwner.id }),
    cached('deploy started', 5, { remote_author: hook }),
    cached('deploy finished', 4, { remote_author: hook }),
    cached('nightly report ready', 3, { remote_author: { kind: 'bot', id: crypto.randomUUID(), name: 'Host Bot', avatar_url: null } }),
    cached('hi from Discord', 2, {
      remote_author: { kind: 'bridge', id: 'discord:4242', name: 'Dana', avatar_url: null, source: 'discord' },
      discord_user: { id: '4242', username: 'Dana', display_name: 'Dana', avatar_url: null },
      bridge_source: 'discord',
    }),
  ]))
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', remote.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, member)
})

test('a copy shows its host\'s bot, webhook and bridged messages under their own names', async ({ page }) => {
  test.setTimeout(150_000)
  // The federation backend's status check for the remote server, answered as its Group would.
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route(`https://${host}/**`, (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }))
  await signIn(page, member)
  await openChannel(page, remote.id, remote.channel)
  const list = messageList(page)
  const header = (name: string) => list.locator('.message-header').filter({ hasText: name })

  await expect(list.getByText('nightly report ready')).toBeVisible({ timeout: 30000 })

  await test.step('the webhook reads under its name and picture, its two messages under one header', async () => {
    await expect(header('RT Deployer')).toHaveCount(1)
    await expect(header('RT Deployer').locator('.webhook-badge')).toHaveText('WEBHOOK')
    await expect(header('RT Deployer').locator('.message-avatar img')).toHaveAttribute('src', hookIcon)
    await expect(list.getByText('deploy finished')).toBeVisible()
  })

  await test.step('the bot reads as a bot, the bridged person with the Discord mark', async () => {
    await expect(header('Host Bot').locator('.bot-badge')).toHaveText('BOT')
    const dana = header('Dana')
    await expect(dana).toHaveCount(1)
    await expect(dana.locator('.bridged-source-icon, .bridge-source-badge')).toHaveCount(1)
    await expect(header(hostOwner.displayName)).toHaveCount(1)
  })

  await test.step('none reads as a deleted user, and the webhook\'s name opens no profile', async () => {
    await expect(list.getByText('Deleted User')).toHaveCount(0)
    await expect(list.getByText('Unknown User')).toHaveCount(0)
    await header('RT Deployer').locator('.username').click()
    await expect(page.getByText('Profile not found')).toHaveCount(0)
    await expect(page.locator('.profile-modal-content')).toHaveCount(0)
  })
})
