// Journey: the invite dialog says who the link admits. With federation off for the server only
// accounts on this instance can join, which the dialog names; with it on, people on other
// instances can join too.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'ifn')
  server = await seedServer(admin, owner, `Invite note ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

async function inviteNote(page: Page) {
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('.server-dropdown li').filter({ hasText: 'Get Invite Link' }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite people' })
  await expect(dialog.getByLabel('Invite link')).toHaveValue(/\/invite\/[A-Z0-9]{8}$/, { timeout: 30000 })
  return dialog.getByTestId('invite-federation')
}

test('the invite dialog says whether accounts on other instances can join', async ({ page }) => {
  test.setTimeout(150_000)
  const host = new URL(process.env.BASE_URL || 'http://localhost:5173').hostname

  await admin.from('servers').update({ federation_enabled: false }).eq('id', server.id)
  await signIn(page, owner)
  const off = await inviteNote(page)
  await expect(off).toHaveText(`Only accounts on ${host} can join with this link: federation is off for this server.`)

  await admin.from('servers').update({ federation_enabled: true }).eq('id', server.id)
  await page.reload()
  const on = await inviteNote(page)
  await expect(on).toHaveText('People on other Harmony instances can join too: federation is on for this server.')
})
