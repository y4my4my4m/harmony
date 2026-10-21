// Journey: an owner turns federation off for a server that has a member from another instance.
// The switch asks first, naming how many members from other instances will be removed and that
// turning federation back on does not bring them back. Cancelling keeps federation on; confirming
// and saving turns it off, removes that member and records the removal the federation backend
// delivers as the Group's Remove (migration 20261025200001; this stack has no federation backend).

import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const remote = { id: crypto.randomUUID(), username: `rm${Date.now().toString(36)}`, domain: 'remote.example' }

test.beforeAll(async () => {
  owner = await createUser(admin, 'fof')
  server = await seedServer(admin, owner, `Fed off ${owner.username}`)
  const fed = await admin.from('servers').update({ federation_enabled: true }).eq('id', server.id)
  if (fed.error) throw new Error(fed.error.message)
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote member',
    domain: remote.domain,
    is_local: false,
    federated_id: `https://${remote.domain}/users/${remote.username}`,
    inbox_url: `https://${remote.domain}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: memberError } = await admin.from('user_servers').insert({
    server_id: server.id, user_id: remote.id, status: 'accepted', member_instance: remote.domain,
  })
  if (memberError) throw new Error(`remote membership: ${memberError.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server.id)
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
})

test('turning federation off names the members from other instances it removes, and removes them', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=privacy`)
  await dismissAnnouncements(page)

  const federation = page.getByRole('switch', { name: 'Enable federation' })
  await expect(federation).toBeChecked({ timeout: 30000 })
  const toggle = page.locator('label.toggle-switch', { has: federation })
  const dialog = page.getByRole('alertdialog', { name: 'Disable federation?' })

  await test.step('the switch asks first and Cancel keeps federation on', async () => {
    await toggle.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('This server has 1 federated member from other instances.')
    await expect(dialog).toContainText('Remove them from this server and tell each of them why')
    await expect(dialog).toContainText('Keep them out if you turn federation back on, until they rejoin with an invite')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(federation).toBeChecked()
  })

  await test.step('confirming and saving removes the member and records the removal', async () => {
    await toggle.click()
    await dialog.getByRole('button', { name: 'Disable federation' }).click()
    await expect(dialog).toBeHidden()
    await expect(federation).not.toBeChecked()

    const saved = page.waitForResponse((r) => r.url().includes('/rpc/update_server') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save changes' }).first().click()
    expect((await saved).status()).toBeLessThan(300)

    await expect.poll(async () => (await admin.from('servers').select('federation_enabled').eq('id', server.id).single()).data?.federation_enabled)
      .toBe(false)
    const { data: members } = await admin.from('user_servers').select('user_id').eq('server_id', server.id)
    expect(members?.map((m) => m.user_id).sort()).toEqual([owner.id])
    const { data: removals } = await admin.from('federation_member_removals')
      .select('profile_id, reason, delivered_at').eq('server_id', server.id)
    expect(removals).toEqual([{ profile_id: remote.id, reason: 'federation_closed', delivered_at: null }])
  })
})
