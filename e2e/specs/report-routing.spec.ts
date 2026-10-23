// Journey: a report says where it goes. Every report goes to this instance's staff; one about a
// message in a server hosted here also goes to its moderators, and the dialog names them; one in a
// server hosted on another instance also goes to that server's moderators unless the reporter
// unchecks it, and the dialog says they never learn who reported (create_report,
// migration 20261027400001). This stack has no federation backend: the queued Flag is read back
// from the report row, not delivered.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

// page.route() does not see requests the app's service worker makes.
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let reader: SpecUser
let neighbour: SpecUser
let home: SeededServer

const host = 'chat.example'
const hostMember = { id: crypto.randomUUID(), username: `rrh${Date.now().toString(36)}`, displayName: 'Loud Guest' }
const remote = { id: crypto.randomUUID(), name: 'Remote Hall', channel: crypto.randomUUID() }
const groupUrl = `https://${host}/servers/${remote.id}`
const remoteMessage = crypto.randomUUID()

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

async function openReport(page: Page, text: string) {
  const row = messageList(page).locator('.message-item').filter({ hasText: text }).first()
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.hover()
  await row.getByTestId('msg-action-more').click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Report message' }).click()
  const dialog = page.getByRole('dialog', { name: 'Report' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function reportOf(reporter: string, message: string) {
  const { data } = await admin.from('reports')
    .select('forward_to_server, server_forward_status, forward, comment')
    .eq('reporter_id', reporter).eq('reported_message_id', message).maybeSingle()
  return data
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'rrr')
  neighbour = await createUser(admin, 'rrn')
  home = await seedServer(admin, neighbour, `Home ${neighbour.username}`)
  await addMember(admin, reader, home.id)
  await must('home message', admin.from('messages').insert({
    channel_id: home.generalChannelId, user_id: neighbour.id, content: [{ type: 'text', text: 'neighbour says hi' }],
  }))

  await must('host member', admin.from('profiles').insert({
    id: hostMember.id, username: hostMember.username, display_name: hostMember.displayName, domain: host, is_local: false,
    federated_id: `https://${host}/users/${hostMember.username}`, inbox_url: `https://${host}/users/${hostMember.username}/inbox`,
  }))
  await must('remote server', admin.from('servers').insert({
    id: remote.id, name: remote.name, owner: hostMember.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: groupUrl, federation_inbox_url: `${groupUrl}/inbox`, federation_domain: host,
  }))
  await admin.from('channels').delete().eq('server_id', remote.id)
  await must('remote channel', admin.from('channels').insert({
    id: remote.channel, server_id: remote.id, name: 'general', type: 0, is_remote: true, ap_id: `${groupUrl}/channels/${remote.channel}`,
  }))
  await must('remote membership', admin.from('user_servers').upsert(
    { server_id: remote.id, user_id: reader.id, status: 'accepted', member_instance: 'localhost' },
    { onConflict: 'user_id,server_id' },
  ))
  await must('remote message', admin.from('messages').insert({
    id: remoteMessage, channel_id: remote.channel, user_id: hostMember.id,
    content: [{ type: 'text', text: 'something nasty from the host' }], federation_status: 'skipped',
    metadata: { ap_id: `https://${host}/messages/${remoteMessage}`, is_remote: true, federated: true },
  }))
})

test.afterAll(async () => {
  await admin.from('reports').delete().eq('reporter_id', reader?.id ?? '')
  await admin.from('servers').delete().eq('id', remote.id)
  await admin.from('profiles').delete().eq('id', hostMember.id)
  for (const u of [reader, neighbour]) await deleteUser(admin, u)
})

test('a report about a message in a server hosted elsewhere also goes to its moderators, by the reporter\'s choice', async ({ page }) => {
  test.setTimeout(150_000)
  // The federation backend's status check for the remote server, answered as its Group would.
  await page.route('**/servers/*/status', (route) => route.fulfill({ json: { federationClosed: false } }))
  await signIn(page, reader)
  await openChannel(page, remote.id, remote.channel)

  const dialog = await openReport(page, 'something nasty from the host')
  const server = dialog.getByTestId('report-forward-server')

  await test.step('the dialog names both destinations and keeps the reporter anonymous to the server', async () => {
    await expect(dialog.getByRole('heading', { name: 'Report' })).toBeVisible()
    await expect(dialog.getByTestId('report-destination')).toHaveText('Goes to localhost staff.')
    await expect(server).toContainText(`Also send to ${remote.name}'s moderators on ${host}`)
    await expect(server).toContainText('They see what you reported and your note, not who you are.')
    await expect(server.getByRole('checkbox')).toBeChecked()
    // The author's instance is the host: its copy of the report reaches it through the server.
    await expect(dialog.locator('.forward-option')).toHaveCount(1)
  })

  await test.step('submitted as left, it is queued for the server\'s moderators', async () => {
    await dialog.getByText('Harassment or bullying').click()
    await dialog.getByRole('textbox').fill('threats in general')
    await dialog.getByRole('button', { name: 'Submit report' }).click()
    await expect(dialog.getByText('Report submitted')).toBeVisible({ timeout: 15000 })
    await expect.poll(() => reportOf(reader.id, remoteMessage), { timeout: 15000 }).toMatchObject({
      forward_to_server: true,
      server_forward_status: 'queued',
      forward: false,
      comment: 'threats in general',
    })
    await dialog.getByRole('button', { name: 'Keep visible' }).click()
  })

  await test.step('unchecked, the report stays with this instance\'s staff', async () => {
    await admin.from('reports').delete().eq('reporter_id', reader.id)
    const again = await openReport(page, 'something nasty from the host')
    await again.getByTestId('report-forward-server').getByRole('checkbox').uncheck()
    await again.getByText('Spam or unwanted content').click()
    await again.getByRole('button', { name: 'Submit report' }).click()
    await expect(again.getByText('Report submitted')).toBeVisible({ timeout: 15000 })
    await expect.poll(() => reportOf(reader.id, remoteMessage), { timeout: 15000 }).toMatchObject({
      forward_to_server: false,
      server_forward_status: null,
    })
  })
})

test('a report in a server hosted here goes to this instance\'s staff and the server\'s moderators', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await openChannel(page, home.id, home.generalChannelId)

  const dialog = await openReport(page, 'neighbour says hi')
  await expect(dialog.getByTestId('report-destination')).toHaveText(`Goes to localhost staff and ${home.name}'s moderators.`)
  await expect(dialog.getByTestId('report-forward-server')).toHaveCount(0)
  await expect(dialog.locator('.forward-option')).toHaveCount(0)
})
