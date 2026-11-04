// Journey: the Admin and Mod badge next to a name names staff of the instance that hosts the chat.
// In a server hosted here only this instance's staff wear it; in a copy of a server hosted
// elsewhere only that host's staff, as its actors publish harmony:instanceRole; in a DM, this
// instance's staff. Staff of any other instance wear no badge in messages or the member list,
// and their profile card still names them staff of their own instance.
//
// profiles.instance_role is written by the federation backend from the remote actor; this stack
// has none, so the rows are written here as it writes them.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  addMember, adminClient, createUser, deleteUser, instanceDomain, messageList, openChannel, seedServer, signIn,
  type SeededServer, type SpecUser,
} from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let viewer: SpecUser
let staff: SpecUser
let local: SeededServer
let domain = ''
let conversationId = ''

const host = 'host.example'
const elsewhere = 'staff.example'
const tag = Date.now().toString(36)
/** Admin of the copy's host. */
const hostAdmin = { id: crypto.randomUUID(), username: `isch${tag}`, displayName: 'Host Admin Hal', domain: host }
/** Admin of a third instance. */
const otherAdmin = { id: crypto.randomUUID(), username: `isco${tag}`, displayName: 'Elsewhere Admin Rae', domain: elsewhere }
const copy = { id: crypto.randomUUID(), channel: crypto.randomUUID(), name: `Hosted elsewhere ${tag}` }
const groupUrl = `https://${host}/servers/${copy.id}`

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

function remoteProfile(p: typeof hostAdmin) {
  return {
    id: p.id, username: p.username, display_name: p.displayName, domain: p.domain, is_local: false,
    federated_id: `https://${p.domain}/users/${p.username}`, inbox_url: `https://${p.domain}/users/${p.username}/inbox`,
  }
}

function text(body: string) {
  return [{ type: 'text', text: body }]
}

test.beforeAll(async () => {
  domain = await instanceDomain(admin)
  viewer = await createUser(admin, 'iscv')
  staff = await createUser(admin, 'isca')
  await must('local admin', admin.from('profiles').update({ is_admin: true }).eq('id', staff.id))
  await must('remote accounts', admin.from('profiles').insert([remoteProfile(hostAdmin), remoteProfile(otherAdmin)]))
  // Stored from each actor's harmony:instanceRole by the federation backend.
  await must('remote staff roles', admin.from('profiles').update({ instance_role: 'admin' }).in('id', [hostAdmin.id, otherAdmin.id]))

  // Hosted here: the local admin and the third instance's admin are members.
  local = await seedServer(admin, viewer, `Hosted here ${tag}`)
  await addMember(admin, staff, local.id)
  await must('remote member here', admin.from('user_servers').upsert(
    { server_id: local.id, user_id: otherAdmin.id, status: 'accepted', member_instance: elsewhere },
    { onConflict: 'user_id,server_id' },
  ))
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  await must('local messages', admin.from('messages').insert([
    { channel_id: local.generalChannelId, user_id: staff.id, content: text('local admin here'), created_at: at(3) },
    { channel_id: local.generalChannelId, user_id: otherAdmin.id, content: text('remote admin here'), created_at: at(2) },
  ]))

  // Hosted by host.example: its admin, the third instance's admin and the local admin are members.
  await must('copy', admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: hostAdmin.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', copy.id)
  await must('copy channel', admin.from('channels').insert({
    id: copy.channel, server_id: copy.id, name: 'general', type: 0, order: 0, is_remote: true, ap_id: `${groupUrl}/channels/${copy.channel}`,
  }))
  await must('copy members', admin.from('user_servers').upsert([
    { server_id: copy.id, user_id: viewer.id, status: 'accepted', member_instance: domain },
    { server_id: copy.id, user_id: staff.id, status: 'accepted', member_instance: domain },
    { server_id: copy.id, user_id: hostAdmin.id, status: 'accepted', member_instance: host },
    { server_id: copy.id, user_id: otherAdmin.id, status: 'accepted', member_instance: elsewhere },
  ], { onConflict: 'user_id,server_id' }))
  const cached = (userId: string, body: string, minutesAgo: number) => {
    const id = crypto.randomUUID()
    return {
      id, channel_id: copy.channel, user_id: userId, content: text(body), created_at: at(minutesAgo), updated_at: at(minutesAgo),
      federation_status: 'skipped', metadata: { ap_id: `https://${host}/messages/${id}`, is_remote: true, federated: true },
    }
  }
  await must('copy messages', admin.from('messages').insert([
    cached(hostAdmin.id, 'host admin in the copy', 4),
    cached(otherAdmin.id, 'remote admin in the copy', 3),
    cached(staff.id, 'local admin in the copy', 2),
  ]))

  // A group DM with the local admin and the third instance's admin.
  const { data, error } = await admin.from('conversations').insert({ type: 'group', created_by: viewer.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversationId = data.id
  await must('participants', admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: viewer.id },
    { conversation_id: conversationId, user_id: staff.id },
    { conversation_id: conversationId, user_id: otherAdmin.id },
  ]))
  await must('dm messages', admin.from('messages').insert([
    { conversation_id: conversationId, user_id: staff.id, content: text('local admin in the dm'), created_at: at(2) },
    { conversation_id: conversationId, user_id: otherAdmin.id, content: text('remote admin in the dm'), created_at: at(1) },
  ]))
})

test.afterAll(async () => {
  if (conversationId) await admin.from('conversations').delete().eq('id', conversationId)
  await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('profiles').delete().in('id', [hostAdmin.id, otherAdmin.id])
  await deleteUser(admin, staff)
  await deleteUser(admin, viewer)
})

const author = (page: Page, name: string) =>
  messageList(page).locator('.message-header').filter({ hasText: name }).first()
const memberRow = (page: Page, name: string) =>
  page.locator('.user-sidebar .user-item').filter({ hasText: name }).first()

test('the staff badge names staff of the instance hosting the chat only', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await page.route('**/servers/*/sync', (route) => route.fulfill({ json: { success: true, message: 'Server synced' } }))
  await signIn(page, viewer)

  await test.step('hosted here: this instance\'s admin wears the badge, naming this instance', async () => {
    await openChannel(page, local.id, local.generalChannelId)
    await expect(messageList(page).getByText('remote admin here')).toBeVisible({ timeout: 30000 })
    const badge = author(page, staff.displayName).getByTestId('message-staff-badge')
    await expect(badge).toContainText('ADMIN')
    await expect(badge).toHaveAttribute('title', `Admin of ${domain}`)
    const row = memberRow(page, staff.displayName)
    await expect(row).toBeVisible({ timeout: 20000 })
    await expect(row.getByTestId('member-staff-badge')).toHaveAttribute('title', `Admin of ${domain}`)
    await expect(row).toContainText(`admin of ${domain}`)
  })

  await test.step('hosted here: another instance\'s admin wears none', async () => {
    // The globe and the domain read the same cached profile as the badge.
    await expect(author(page, otherAdmin.displayName).getByTestId('federated-user-badge')).toBeVisible()
    await expect(author(page, otherAdmin.displayName).getByTestId('message-staff-badge')).toHaveCount(0)
    const row = memberRow(page, otherAdmin.displayName)
    await expect(row.locator('.user-domain')).toHaveText(elsewhere, { timeout: 20000 })
    await expect(row.getByTestId('member-staff-badge')).toHaveCount(0)
    await expect(row).not.toContainText(`admin of ${elsewhere}`)
  })

  await test.step('their profile card still names them admin of their own instance', async () => {
    await memberRow(page, otherAdmin.displayName).click()
    await expect(page.getByTestId('profile-staff-badge')).toHaveText(`Admin of ${elsewhere}`, { timeout: 15000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('profile-staff-badge')).toBeHidden()
  })

  await test.step('a copy hosted elsewhere: the host\'s admin wears the badge, naming the host', async () => {
    await openChannel(page, copy.id, copy.channel)
    await expect(messageList(page).getByText('local admin in the copy')).toBeVisible({ timeout: 30000 })
    const badge = author(page, hostAdmin.displayName).getByTestId('message-staff-badge')
    await expect(badge).toContainText('ADMIN')
    await expect(badge).toHaveAttribute('title', `Admin of ${host}`)
    const row = memberRow(page, hostAdmin.displayName)
    await expect(row).toBeVisible({ timeout: 20000 })
    await expect(row.getByTestId('member-staff-badge')).toHaveAttribute('title', `Admin of ${host}`)
  })

  await test.step('a copy hosted elsewhere: a third instance\'s admin and this instance\'s admin wear none', async () => {
    for (const name of [otherAdmin.displayName, staff.displayName]) {
      await expect(author(page, name)).toBeVisible()
      await expect(author(page, name).getByTestId('message-staff-badge')).toHaveCount(0)
      await expect(memberRow(page, name)).toBeVisible({ timeout: 20000 })
      await expect(memberRow(page, name).getByTestId('member-staff-badge')).toHaveCount(0)
    }
  })

  await test.step('a DM: this instance\'s admin wears the badge, another instance\'s none', async () => {
    await page.goto(`/dm/${conversationId}`)
    await expect(messageList(page).getByText('remote admin in the dm')).toBeVisible({ timeout: 30000 })
    const badge = author(page, staff.displayName).getByTestId('message-staff-badge')
    await expect(badge).toContainText('ADMIN')
    await expect(badge).toHaveAttribute('title', `Admin of ${domain}`)
    await expect(author(page, otherAdmin.displayName).getByTestId('federated-user-badge')).toBeVisible()
    await expect(author(page, otherAdmin.displayName).getByTestId('message-staff-badge')).toHaveCount(0)
  })
})
