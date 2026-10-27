// Journey: a copy of a server hosted on another instance shows what its host shows: channels and
// categories in the host's order, the host's roles grouping and colouring the member list, the
// host's pins, and the staff badge a remote account's own instance gives it. Entering the copy
// asks the federation backend, as the signed-in member, to read it again from its host.
//
// The federation backend writes these rows (services/CopyMirrorService.ts, migration
// 20261030100001): roles under the Group's ids with no permission bits, the copy's own Admin role
// gone, assignments as user_roles, pins as is_pinned with the host's time and no pinner, and
// profiles.instance_role from the remote actor. This stack has no federation backend: the rows
// are written here as it writes them.

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, messageList, openChannel, signIn, type SpecUser } from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let member: SpecUser

const host = 'roles.example'
const hostOwner = { id: crypto.randomUUID(), username: `rcd${Date.now().toString(36)}`, displayName: 'Host Owner Ada' }
const remote = { id: crypto.randomUUID(), name: 'Remote Roles' }
const groupUrl = `https://${host}/servers/${remote.id}`
const categories = { info: crypto.randomUUID(), chat: crypto.randomUUID() }
const channels = {
  rules: crypto.randomUUID(), announcements: crypto.randomUUID(), general: crypto.randomUUID(), random: crypto.randomUUID(),
}
const roles = { admin: crypto.randomUUID(), tester: crypto.randomUUID() }
const ADMIN_COLOR = '#f1c40f'
const TESTER_COLOR = '#2ecc71'

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

/** A row as the federation backend caches one of the host's Notes. */
function cached(text: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID()
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    id, channel_id: channels.general, user_id: hostOwner.id, content: [{ type: 'text', text }], created_at: at, updated_at: at,
    federation_status: 'skipped', metadata: { ap_id: `https://${host}/messages/${id}`, is_remote: true, federated: true }, ...extra,
  }
}

test.beforeAll(async () => {
  member = await createUser(admin, 'rcd')
  await must('host owner', admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: hostOwner.displayName, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  }))
  // Stored from the owner's actor (harmony:instanceRole) by the federation backend.
  await must('host owner staff role', admin.from('profiles').update({ instance_role: 'admin' }).eq('id', hostOwner.id))
  await must('remote server', admin.from('servers').insert({
    id: remote.id, name: remote.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', remote.id)
  await must('categories', admin.from('channel_categories').insert([
    { id: categories.chat, server_id: remote.id, name: 'Chat', order: 1 },
    { id: categories.info, server_id: remote.id, name: 'Info', order: 0 },
  ]))
  const channel = (id: string, name: string, category: string, order: number) => ({
    id, server_id: remote.id, name, type: 0, order, category, is_remote: true, ap_id: `${groupUrl}/channels/${id}`,
  })
  await must('channels', admin.from('channels').insert([
    channel(channels.random, 'random', categories.chat, 1),
    channel(channels.general, 'general', categories.chat, 0),
    channel(channels.announcements, 'announcements', categories.info, 1),
    channel(channels.rules, 'rules', categories.info, 0),
  ]))

  // The host's roles replace the copy's own Admin role.
  await must('copy admin role', admin.from('server_roles').delete().eq('server_id', remote.id).eq('is_default', false))
  const role = (id: string, name: string, color: string, position: number) => ({
    id, server_id: remote.id, name, color, position, hoist: true, mentionable: true, permissions: 0, is_admin: false,
    is_default: false, ap_id: `${groupUrl}/roles/${id}`,
  })
  await must('roles', admin.from('server_roles').insert([
    role(roles.admin, 'ADMIN', ADMIN_COLOR, 10),
    role(roles.tester, 'TESTER', TESTER_COLOR, 5),
  ]))
  await must('memberships', admin.from('user_servers').upsert([
    { server_id: remote.id, user_id: member.id, status: 'accepted', member_instance: 'localhost' },
    { server_id: remote.id, user_id: hostOwner.id, status: 'accepted', member_instance: host },
  ], { onConflict: 'user_id,server_id' }))
  await must('assignments', admin.from('user_roles').insert([
    { user_id: hostOwner.id, role_id: roles.admin, server_id: remote.id },
    { user_id: member.id, role_id: roles.tester, server_id: remote.id },
  ]))

  const pinnedAt = new Date(Date.now() - 60_000).toISOString()
  await must('cached rows', admin.from('messages').insert([
    cached('read the rules before posting', 30, { is_pinned: true, pinned_at: pinnedAt }),
    cached('this one is not pinned', 2),
  ]))
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', remote.id)
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, member)
})

test('a copy shows its host\'s channel order, roles, pins and the staff of other instances', async ({ page }) => {
  test.setTimeout(150_000)
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  const syncs: { url: string; auth: string | undefined }[] = []
  await page.route('**/servers/*/sync', (route) => {
    syncs.push({ url: route.request().url(), auth: route.request().headers().authorization })
    return route.fulfill({ json: { success: true, message: 'Server synced' } })
  })
  await signIn(page, member)
  await openChannel(page, remote.id, channels.general)
  await expect(messageList(page).getByText('this one is not pinned')).toBeVisible({ timeout: 30000 })

  await test.step('entering the copy reads it again from its host, as the member', async () => {
    await expect.poll(() => syncs.filter((s) => s.url.includes(`/servers/${remote.id}/sync`)).length).toBe(1)
    expect(syncs[0].auth).toMatch(/^Bearer \S+/)
  })

  await test.step('categories and channels stand in the host\'s order', async () => {
    const sidebar = page.locator('.channel-sidebar')
    await expect(sidebar.locator('.category-name')).toHaveText(['Info', 'Chat'])
    await expect.poll(() => sidebar.locator('li.channel-wrapper').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.channelId)))
      .toEqual([channels.rules, channels.announcements, channels.general, channels.random])
  })

  const members = page.locator('.user-sidebar')
  const row = (name: string) => members.locator('.user-item').filter({ hasText: name }).first()

  await test.step('the host\'s hoisted role groups the member list, and its colour names the member', async () => {
    const tester = members.locator('.group-header').filter({ hasText: 'TESTER' })
    await expect(tester).toBeVisible({ timeout: 20000 })
    await expect(tester.locator('.group-title-text')).toHaveText('TESTER - 1')
    await expect(tester.locator('.role-color-dot')).toHaveCSS('background-color', 'rgb(46, 204, 113)')
    await expect(row(member.displayName).locator('.user-name')).toHaveCSS('color', 'rgb(46, 204, 113)')
    await expect(row(hostOwner.displayName).locator('.user-name')).toHaveCSS('color', 'rgb(241, 196, 15)')
  })

  await test.step('a remote account wears the badge its own instance gives it, naming that instance', async () => {
    const badge = row(hostOwner.displayName).getByTestId('member-staff-badge')
    await expect(badge).toHaveClass(/admin/)
    await expect(badge).toHaveAttribute('title', `admin of ${host}`)
    await expect(row(member.displayName).getByTestId('member-staff-badge')).toHaveCount(0)
    const author = messageList(page).locator('.message-header').filter({ hasText: hostOwner.displayName }).first()
    await expect(author.getByTestId('message-staff-badge')).toHaveText('ADMIN')
    await expect(author.getByTestId('message-staff-badge')).toHaveAttribute('title', `admin of ${host}`)
  })

  await test.step('the pinned list holds the host\'s pins', async () => {
    // Named by its count once the channel holds pins.
    await page.locator('.chat-header').getByRole('button', { name: '1 pinned message' }).click()
    const pins = page.getByRole('dialog', { name: 'Pinned messages' })
    await expect(pins).toBeVisible({ timeout: 10000 })
    await expect(pins.getByText('read the rules before posting')).toBeVisible({ timeout: 10000 })
    await expect(pins.getByText('this one is not pinned')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(pins).toBeHidden()
  })

  await test.step('the remote account\'s card names it staff of its own instance', async () => {
    await row(hostOwner.displayName).click()
    await expect(page.getByTestId('profile-staff-badge')).toHaveText(`Admin of ${host}`, { timeout: 15000 })
  })
})
