// Journey: the instance's federation switches close federation (migration 20261028500001).
// An admin turns both off: the panel warns and asks first; every local server's federation turns
// off and removes its member from another instance, and every local member of a server hosted
// elsewhere leaves it and is told why. While closed, a server owner cannot turn federation on.
// One switch on again reopens the servers the closing turned off.
//
// Closing touches every server of the stack: the spec runs its steps in order and restores the
// switches it found.

import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import {
  addMember,
  adminClient,
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
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const INSTANCE = 'localhost'
const KEYS = ['enable_inbound_federation', 'enable_outbound_federation', 'federation_settings']
let staff: SpecUser
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let saved: Array<{ config_key: string; config_value: unknown }> = []

const host = 'closing.example'
const remoteUser = { id: crypto.randomUUID(), username: `ifs${Date.now().toString(36)}` }
const copy = { id: crypto.randomUUID(), name: 'Faraway Hall' }

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

async function switches(): Promise<Record<string, unknown>> {
  const { data } = await admin.rpc('get_public_federation_settings')
  return (data ?? {}) as Record<string, unknown>
}

const toggleLabel = (page: Page, testId: string) => page.locator('label').filter({ has: page.getByTestId(testId) })

async function openFederationTab(page: Page) {
  await page.goto('/admin?tab=config')
  await dismissAnnouncements(page)
  await page.locator('.config-tab-btn').filter({ hasText: 'Federation' }).click()
  await expect(toggleLabel(page, 'federation-inbound-toggle')).toContainText('Receive from other instances', { timeout: 15000 })
}
const saveFederation = (page: Page) => page.locator('.config-section').filter({ hasText: 'Federation settings' })
  .getByRole('button', { name: 'Save changes' }).click()

test.beforeAll(async () => {
  saved = (await admin.from('instance_config').select('config_key, config_value').in('config_key', KEYS)).data ?? []
  await must('switches on', admin.from('instance_config').upsert([
    { config_key: 'enable_inbound_federation', config_value: true },
    { config_key: 'enable_outbound_federation', config_value: true },
  ], { onConflict: 'config_key' }))

  staff = await createUser(admin, 'ifa')
  owner = await createUser(admin, 'ifo')
  member = await createUser(admin, 'ifm')
  await must('staff', admin.from('profiles').update({ is_admin: true }).eq('id', staff.id))
  server = await seedServer(admin, owner, `Open ${owner.username}`)
  await addMember(admin, member, server.id)
  await must('federate', admin.from('servers').update({ federation_enabled: true }).eq('id', server.id))

  await must('remote user', admin.from('profiles').insert({
    id: remoteUser.id, username: remoteUser.username, display_name: 'Remote member', domain: host, is_local: false,
    federated_id: `https://${host}/users/${remoteUser.username}`, inbox_url: `https://${host}/users/${remoteUser.username}/inbox`,
  }))
  await must('remote member', admin.from('user_servers').insert({ server_id: server.id, user_id: remoteUser.id, status: 'accepted' }))
  await must('copy', admin.from('servers').insert({
    id: copy.id, name: copy.name, owner: remoteUser.id, public: true, is_local_server: false, federation_enabled: true,
    ap_id: `https://${host}/servers/${copy.id}`, federation_inbox_url: `https://${host}/servers/${copy.id}/inbox`, federation_domain: host,
  }))
  await must('copy membership', admin.from('user_servers').insert({ server_id: copy.id, user_id: member.id, status: 'accepted', member_instance: INSTANCE }))
})

test.afterAll(async () => {
  await admin.from('instance_config').delete().in('config_key', KEYS)
  if (saved.length) await admin.from('instance_config').upsert(saved, { onConflict: 'config_key' })
  await admin.from('servers').delete().in('id', [copy.id, server?.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remoteUser.id)
  for (const u of [staff, owner, member]) await deleteUser(admin, u)
})

test('turning both switches off closes federation, and one on again reopens it', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, staff)
  await openFederationTab(page)

  await test.step('the panel shows the switches as stored and warns before closing', async () => {
    await expect(page.getByTestId('federation-inbound-toggle')).toBeChecked()
    await expect(page.getByTestId('federation-outbound-toggle')).toBeChecked()
    await toggleLabel(page, 'federation-outbound-toggle').click()
    await expect(page.getByTestId('federation-closed-warning')).toHaveCount(0)
    await toggleLabel(page, 'federation-inbound-toggle').click()
    await expect(page.getByTestId('federation-closed-warning')).toContainText('federation closes')

    await saveFederation(page)
    const dialog = page.locator('.modal-container').filter({ hasText: 'Close federation?' })
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    expect(await switches()).toMatchObject({ enable_inbound_federation: true, enable_outbound_federation: true })

    await saveFederation(page)
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('button', { name: 'Close federation', exact: true }).click()
    await expect.poll(switches, { timeout: 15000 })
      .toMatchObject({ federation_enabled: false, enable_inbound_federation: false, enable_outbound_federation: false })
  })

  await test.step('every local server stops federating and removes its member from another instance', async () => {
    const { data: row } = await admin.from('servers').select('federation_enabled').eq('id', server.id).single()
    expect(row?.federation_enabled).toBe(false)
    const { data: removal } = await admin.from('federation_member_removals').select('reason')
      .eq('server_id', server.id).eq('profile_id', remoteUser.id)
    expect(removal).toEqual([{ reason: 'federation_closed' }])
    const { count } = await admin.from('user_servers').select('*', { count: 'exact', head: true })
      .eq('server_id', server.id).eq('user_id', remoteUser.id)
    expect(count).toBe(0)
  })

  await test.step('the member leaves the server hosted elsewhere and is told why', async () => {
    const { data: leaves } = await admin.from('instance_server_leaves').select('reason')
      .eq('server_id', copy.id).eq('profile_id', member.id)
    expect(leaves).toEqual([{ reason: 'federation_off' }])
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const other = await context.newPage()
    await signIn(other, member)
    await openChannel(other, server.id, server.generalChannelId)
    await other.locator('[data-testid="notification-bell"]').click()
    const notice = other.locator('[data-testid="notification-panel"] [data-testid="notification-item"][data-type="server_instance_removed"]')
    await expect(notice).toContainText(`${INSTANCE} stopped federating; you left ${copy.name}.`, { timeout: 30000 })
    await context.close()
  })

  await test.step('while closed, the owner cannot turn federation on', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const ownerPage = await context.newPage()
    await signIn(ownerPage, owner)
    await ownerPage.goto(`/server/${server.id}?section=privacy`)
    await dismissAnnouncements(ownerPage)
    await expect(ownerPage.getByTestId('server-federation-instance-off'))
      .toContainText('Federation is off on this instance', { timeout: 30000 })
    await expect(ownerPage.getByTestId('server-federation-toggle')).toBeDisabled()
    await expect(ownerPage.getByTestId('server-federation-toggle')).not.toBeChecked()
    await context.close()

    const ownerClient = await userClient(owner)
    const { error } = await ownerClient.from('servers').update({ federation_enabled: true }).eq('id', server.id)
    expect(error?.message).toContain('INSTANCE_FEDERATION_OFF')
  })

  await test.step('one switch on again reopens the server; nobody removed comes back', async () => {
    await openFederationTab(page)
    await expect(page.getByTestId('federation-inbound-toggle')).not.toBeChecked()
    await toggleLabel(page, 'federation-inbound-toggle').click()
    await saveFederation(page)
    await expect.poll(async () => (await admin.from('servers').select('federation_enabled').eq('id', server.id).single()).data?.federation_enabled,
      { timeout: 15000 }).toBe(true)
    const { count } = await admin.from('user_servers').select('*', { count: 'exact', head: true })
      .eq('server_id', server.id).eq('user_id', remoteUser.id)
    expect(count).toBe(0)
  })
})
