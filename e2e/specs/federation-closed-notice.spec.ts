// Journey: a server on another instance removed this user. Its Group's Remove makes the federation
// backend write a 'server_federation_closed' notification (federation turned off) or a
// 'server_member_removed' one (a kick, a ban); the inbox says which, and federation off does not
// read as a ban. The rows are written here as the backend writes them (this stack has no
// federation backend); the live toast and the removal from the list need Realtime, which this
// stack lacks (utils/joinRejected.ts unit tests).
//
// When the Remove never arrived, the server is still in the list and its Group reports
// harmony:federationEnabled false (GET /servers/:id/status, answered here as the backend
// answers it): the server view says why it is silent and offers Leave, in place of its messages.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, dismissAnnouncements, messageList, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let reader: SpecUser
let home: SeededServer
const host = 'chat.example'
const hostOwner = { id: crypto.randomUUID(), username: `own${Date.now().toString(36)}` }
const closed = { id: crypto.randomUUID(), name: 'Closed Hall', channel: crypto.randomUUID() }
const open = { id: crypto.randomUUID(), name: 'Open Hall', channel: crypto.randomUUID() }
const groupUrl = (id: string) => `https://${host}/servers/${id}`

async function seedRemoteServer(s: { id: string; name: string; channel: string }) {
  const { error } = await admin.from('servers').insert({
    id: s.id, name: s.name, owner: hostOwner.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl(s.id), federation_inbox_url: `${groupUrl(s.id)}/inbox`, federation_domain: host,
  })
  if (error) throw new Error(`remote server ${s.name}: ${error.message}`)
  await admin.from('channels').delete().eq('server_id', s.id)
  const channel = await admin.from('channels').insert({
    id: s.channel, server_id: s.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl(s.id)}/channels/${s.channel}`,
  })
  if (channel.error) throw new Error(`remote channel: ${channel.error.message}`)
  const member = await admin.from('user_servers').upsert(
    { server_id: s.id, user_id: reader.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  )
  if (member.error) throw new Error(`membership: ${member.error.message}`)
}

/** Answers the federation backend's status check for the remote servers as their Groups would. */
async function answerStatus(page: Page) {
  await page.route('**/servers/*/status', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    return route.fulfill({ json: { federationClosed: id === closed.id } })
  })
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'fcn')
  home = await seedServer(admin, reader, `Home ${reader.username}`)
  const { error: ownerError } = await admin.from('profiles').insert({
    id: hostOwner.id, username: hostOwner.username, display_name: 'Host owner', domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostOwner.username}`, inbox_url: `https://${host}/users/${hostOwner.username}/inbox`,
  })
  if (ownerError) throw new Error(`host owner: ${ownerError.message}`)
  await seedRemoteServer(closed)
  await seedRemoteServer(open)

  const { error } = await admin.from('notifications').insert([
    {
      user_id: reader.id,
      type: 'server_federation_closed',
      data: { server: { id: crypto.randomUUID(), name: 'Mastodon Canada', ap_id: `https://${host}/servers/aa` } },
    },
    {
      user_id: reader.id,
      type: 'server_member_removed',
      data: { server: { id: crypto.randomUUID(), name: 'Town Hall', ap_id: `https://${host}/servers/bb` }, action: 'kick', reason: 'off topic' },
    },
  ])
  if (error) throw new Error(error.message)
})

test.afterAll(async () => {
  await admin.from('servers').delete().in('id', [closed.id, open.id])
  await admin.from('profiles').delete().eq('id', hostOwner.id)
  await deleteUser(admin, reader)
})

test('the inbox says a server stopped taking members from other instances, not that the user was banned', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await openChannel(page, home.id, home.generalChannelId)

  await page.locator('[data-testid="notification-bell"]').click()
  const panel = page.locator('[data-testid="notification-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })

  const closedNotice = panel.locator('[data-testid="notification-item"][data-type="server_federation_closed"]')
  await expect(closedNotice).toContainText(
    'Mastodon Canada stopped taking members from other instances, so you were removed.', { timeout: 30000 })
  await expect(closedNotice).toContainText('You can rejoin if it opens again.')
  await expect(closedNotice).not.toContainText(/ban/i)

  const kicked = panel.locator('[data-testid="notification-item"][data-type="server_member_removed"]')
  await expect(kicked).toContainText('You were removed from Town Hall')
  await expect(kicked).toContainText('Reason given: off topic')
})

test('a server closed to this instance says why in place of its messages, and offers Leave', async ({ page }) => {
  test.setTimeout(150_000)
  await answerStatus(page)
  await signIn(page, reader)

  await test.step('an open remote server shows its channel', async () => {
    await openChannel(page, open.id, open.channel)
    await expect(page.getByTestId('remote-server-closed')).toHaveCount(0)
  })

  const notice = page.getByTestId('remote-server-closed')
  await test.step('the closed one says why, without calling it a ban of the user', async () => {
    await page.goto(`/chat/${closed.id}/${closed.channel}`)
    await dismissAnnouncements(page)
    await expect(notice).toBeVisible({ timeout: 30000 })
    await expect(notice).toContainText('Closed Hall stopped taking members from other instances')
    await expect(notice).toContainText('This is not a ban: you can rejoin if it opens again.')
    await expect(messageList(page)).toHaveCount(0)
  })

  await test.step('Leave leaves the server', async () => {
    // The federation backend's /servers/leave deletes the membership and sends the Leave.
    await page.route('**/servers/leave', async (route) => {
      await admin.from('user_servers').delete().eq('server_id', closed.id).eq('user_id', reader.id)
      await route.fulfill({ json: { success: true, message: 'Left server successfully' } })
    })
    await notice.getByRole('button', { name: 'Leave server' }).click()
    const confirm = page.getByRole('alertdialog').filter({ hasText: 'Closed Hall' })
    await confirm.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(page).not.toHaveURL(new RegExp(closed.id), { timeout: 15000 })
    const { data } = await admin.from('user_servers').select('id').eq('server_id', closed.id).eq('user_id', reader.id)
    expect(data).toEqual([])
  })
})
