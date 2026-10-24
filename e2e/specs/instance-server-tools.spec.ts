// Journey: this instance's staff and a server hosted on another instance (migration
// 20261027300001). Every tool names its scope, "on {instance}", and changes this instance only.
//
//   - Admin > Federation lists "Servers from other instances"; Manage opens "On {instance}".
//   - Hiding the server's media: a member's message shows "Attachment hidden on {instance}" in
//     place of its picture, and its text.
//   - The member menu's "Remove from {server} on {instance}" says the server's moderators are not
//     told; with "Keep them out" the member leaves, is kept out, is told by notice, and the Leave
//     is queued for the federation backend (this stack has none).
//   - Blocking lists its consequences with the count of members from here, saying when the staff
//     member blocking is one of them, removes them, and the server is shown blocked.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, dismissAnnouncements, messageList, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
// VITE_DOMAIN of the stack's dev server, which the app names itself by.
const INSTANCE = 'localhost'
const host = 'chat.example'
let staff: SpecUser
let member: SpecUser
let home: SeededServer
const hostOwner = { id: crypto.randomUUID(), username: `own${Date.now().toString(36)}` }
const author = { id: crypto.randomUUID(), username: `aut${Date.now().toString(36)}` }
const copy = { id: crypto.randomUUID(), name: `Elsewhere ${Date.now().toString(36)}`, channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${copy.id}`

async function remoteProfile(p: { id: string; username: string }, name: string) {
  const { error } = await admin.from('profiles').insert({
    id: p.id, username: p.username, display_name: name, domain: host, is_local: false,
    federated_id: `https://${host}/users/${p.username}`, inbox_url: `https://${host}/users/${p.username}/inbox`,
  })
  if (error) throw new Error(`remote profile ${p.username}: ${error.message}`)
}

async function join(user: SpecUser) {
  const { error } = await admin.from('user_servers').upsert(
    { server_id: copy.id, user_id: user.id, status: 'accepted', member_instance: INSTANCE },
    { onConflict: 'user_id,server_id' },
  )
  if (error) throw new Error(`membership of ${user.username}: ${error.message}`)
}

async function openManage(page: Page) {
  await page.goto('/admin?tab=federation')
  await dismissAnnouncements(page)
  const list = page.getByTestId('remote-servers-admin')
  await expect(list).toBeVisible({ timeout: 30000 })
  const row = list.getByTestId('remote-server-row').filter({ hasText: copy.name })
  await row.getByRole('button', { name: `Manage ${copy.name} on ${INSTANCE}` }).click()
  const panel = page.getByTestId('instance-server-panel')
  await expect(panel.getByRole('heading', { name: `On ${INSTANCE}`, exact: true })).toBeVisible({ timeout: 15000 })
  return { list, row, panel }
}

test.beforeAll(async () => {
  staff = await createUser(admin, 'ist')
  member = await createUser(admin, 'ism')
  home = await seedServer(admin, member, `Home ${member.username}`)
  // A shortcode in the name: the people list draws the emoji, as names elsewhere do.
  const promoted = await admin.from('profiles').update({ is_admin: true, display_name: `${staff.displayName} :fire:` }).eq('id', staff.id)
  if (promoted.error) throw new Error(promoted.error.message)
  await remoteProfile(hostOwner, 'Host owner')
  await remoteProfile(author, 'Remote author')

  const { error } = await admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host, host_domain: host,
  })
  if (error) throw new Error(`copy: ${error.message}`)
  await admin.from('channels').delete().eq('server_id', copy.id)
  const channel = await admin.from('channels').insert({
    id: copy.channel, server_id: copy.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${copy.channel}`,
  })
  if (channel.error) throw new Error(`channel: ${channel.error.message}`)
  await join(staff)
  await join(member)
  const authorMembership = await admin.from('user_servers').insert(
    { server_id: copy.id, user_id: author.id, status: 'accepted', member_instance: host })
  if (authorMembership.error) throw new Error(authorMembership.error.message)

  const message = await admin.from('messages').insert({
    channel_id: copy.channel,
    user_id: author.id,
    content: [
      { type: 'text', text: 'a picture from elsewhere' },
      { type: 'file', fileType: 'image', url: `https://${host}/media/cat.png`, fileName: 'cat.png' },
    ],
    federation_status: 'completed',
    metadata: { federated: true, ap_id: `https://${host}/messages/${crypto.randomUUID()}` },
  })
  if (message.error) throw new Error(`message: ${message.error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', copy.id)
  await admin.from('profiles').delete().in('id', [hostOwner.id, author.id])
  await deleteUser(admin, staff)
  await deleteUser(admin, member)
})

test('staff hide a remote server\'s media on this instance; a member sees it hidden', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)
  const { row, panel } = await openManage(page)

  await test.step('the list names the members from here; the panel names its scope', async () => {
    await expect(row).toContainText(`2 members from ${INSTANCE}`)
    await expect(panel).toContainText(
      `These tools only affect ${INSTANCE}: what people here see, and whether they can take part. `
      + `${copy.name} and its members on other instances are not affected.`)
    await expect(panel).toContainText(`Hosted on ${host}`)
  })

  await test.step('names in the people list draw their emoji', async () => {
    const self = panel.getByTestId('instance-person').filter({ hasText: staff.displayName })
    await expect(self).toBeVisible()
    await expect(self.locator('.person-name')).not.toContainText(':fire:')
    await expect.poll(async () => (await self.locator('.person-name img.display-name-emoji').count())
      + ((await self.locator('.person-name').textContent())?.includes('\u{1F525}') ? 1 : 0)).toBeGreaterThan(0)
  })

  await test.step('Hide media switches on and is stored', async () => {
    const media = panel.getByRole('switch', { name: `Hide media from ${copy.name} on ${INSTANCE}` })
    await expect(panel).toContainText(`Pictures, videos and files from it show as hidden for everyone on ${INSTANCE}.`)
    await media.click()
    await expect(media).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await admin.from('instance_server_blocks').select('media_hidden')
      .eq('server_id', copy.id).maybeSingle()).data?.media_hidden).toBe(true)
  })

  await test.step('a member sees the text and a hidden-media notice, not the picture', async () => {
    const context = await browser.newContext()
    const other = await context.newPage()
    await signIn(other, member)
    await openChannel(other, copy.id, copy.channel)
    const list = messageList(other)
    await expect(list).toContainText('a picture from elsewhere', { timeout: 30000 })
    await expect(list.getByTestId('media-hidden')).toHaveText(`Attachment hidden on ${INSTANCE}`)
    await expect(list.locator('img.content-image')).toHaveCount(0)
    await context.close()
  })
})

test('staff remove a member from here, who is kept out and told why; the server is not told', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)
  await openChannel(page, copy.id, copy.channel)

  const row = page.locator('.user-sidebar .user-item').filter({ hasText: member.displayName }).first()
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: `Remove from ${copy.name} on ${INSTANCE}` }).click()

  const dialog = page.getByRole('alertdialog', { name: `Remove from ${copy.name} on ${INSTANCE}` })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(
    `${member.displayName} leaves ${copy.name}. This only affects ${INSTANCE}: the server's moderators are not told, `
    + `and ${member.displayName} is not banned there.`)
  await dialog.getByRole('checkbox', { name: `Keep them out (they can't rejoin from ${INSTANCE})` }).check()
  await dialog.getByLabel(`Reason (shown to ${member.displayName})`).fill('spam links')
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 15000 })

  await test.step('the member left, is kept out, and their Leave is queued', async () => {
    const { data: membership } = await admin.from('user_servers').select('id').eq('server_id', copy.id).eq('user_id', member.id)
    expect(membership).toEqual([])
    const { data: keepout } = await admin.from('instance_server_keepouts').select('reason, set_by')
      .eq('server_id', copy.id).eq('profile_id', member.id).single()
    expect(keepout).toEqual({ reason: 'spam links', set_by: staff.id })
    const { data: leaves } = await admin.from('instance_server_leaves').select('reason, delivered_at')
      .eq('server_id', copy.id).eq('profile_id', member.id)
    expect(leaves).toEqual([{ reason: 'removed', delivered_at: null }])
    const rejoin = await admin.from('user_servers').insert({ server_id: copy.id, user_id: member.id, status: 'accepted' })
    expect(rejoin.error?.message).toContain('KEPT_OUT_HERE')
  })

  await test.step('the member is told who removed them, and why', async () => {
    const context = await browser.newContext()
    const other = await context.newPage()
    await signIn(other, member)
    await openChannel(other, home.id, home.generalChannelId)
    await other.locator('[data-testid="notification-bell"]').click()
    const notice = other.locator('[data-testid="notification-panel"] [data-testid="notification-item"][data-type="server_instance_removed"]')
    await expect(notice).toContainText(`You were removed from ${copy.name} by ${INSTANCE} staff.`, { timeout: 30000 })
    await expect(notice).toContainText('Reason given: spam links')
    await context.close()
  })

  await test.step('the panel lists them kept out, and Let back in lifts it', async () => {
    const { panel } = await openManage(page)
    const kept = panel.getByTestId('instance-person').filter({ hasText: member.displayName })
    await expect(kept).toContainText('Kept out')
    await kept.getByRole('button', { name: `Let ${member.displayName} rejoin ${copy.name} from ${INSTANCE}` }).click()
    await expect.poll(async () => (await admin.from('instance_server_keepouts').select('profile_id')
      .eq('server_id', copy.id).eq('profile_id', member.id)).data?.length).toBe(0)
    await join(member)
  })
})

test('blocking lists what it does, with the members from here, and removes them', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)
  const { list, panel } = await openManage(page)

  await panel.getByRole('button', { name: `Block ${copy.name} on ${INSTANCE}` }).click()
  const dialog = page.getByRole('alertdialog', { name: `Block ${copy.name} on ${INSTANCE}` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('listitem')).toHaveText([
    `People on ${INSTANCE} can no longer see or join it.`,
    `The 2 members from ${INSTANCE} leave it and are told why.`,
    `This includes you: you leave ${copy.name} too.`,
    `Nothing changes for ${copy.name} or for anyone on other instances.`,
  ])
  await dialog.getByLabel(`Reason (only ${INSTANCE} staff see it)`).fill('raids')
  await dialog.getByRole('button', { name: 'Block', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 15000 })

  await expect(panel.getByTestId('instance-blocked-badge')).toHaveText(`Blocked on ${INSTANCE}`)
  await expect(panel).toContainText('raids')
  await expect(panel.getByRole('button', { name: `Allow ${copy.name} on ${INSTANCE} again` })).toBeVisible()

  const { data: block } = await admin.from('instance_server_blocks').select('blocked, reason').eq('server_id', copy.id).single()
  expect(block).toEqual({ blocked: true, reason: 'raids' })
  const { data: left } = await admin.from('user_servers').select('user_id').eq('server_id', copy.id)
  expect(left?.map((r) => r.user_id)).toEqual([author.id])
  const { data: notices } = await admin.from('notifications').select('user_id, data')
    .eq('type', 'server_instance_removed').in('user_id', [staff.id, member.id])
  expect(notices?.filter((n) => (n.data as any)?.action === 'block').map((n) => n.user_id).sort())
    .toEqual([staff.id, member.id].sort())

  await page.getByRole('button', { name: 'Close' }).last().click()
  await expect(list.getByTestId('remote-server-row').filter({ hasText: copy.name })).toContainText('Blocked')
})
