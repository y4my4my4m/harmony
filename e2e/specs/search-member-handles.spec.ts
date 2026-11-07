// Journey: the from: suggestions of server message search name a member of another instance by
// the full handle, @name@domain, and a member of this instance as @name, so two members of the
// same name on different instances are told apart.

import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const DOMAIN = 'remote.e2e.test'
let owner: SpecUser
let server: SeededServer
const remote = { id: crypto.randomUUID(), username: `smh${Date.now().toString(36)}` }

test.beforeAll(async () => {
  owner = await createUser(admin, 'smho')
  server = await seedServer(admin, owner, `Handles ${owner.username.slice(-6)}`)
  const profile = await admin.from('profiles').insert({
    id: remote.id, username: remote.username, display_name: 'Far Member', domain: DOMAIN, is_local: false,
    federated_id: `https://${DOMAIN}/users/${remote.username}`, inbox_url: `https://${DOMAIN}/users/${remote.username}/inbox`,
  })
  if (profile.error) throw new Error(`remote profile: ${profile.error.message}`)
  const member = await admin.from('user_servers').insert({
    server_id: server.id, user_id: remote.id, status: 'accepted', member_instance: DOMAIN,
  })
  if (member.error) throw new Error(`membership: ${member.error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
})

test('from: suggestions show the full handle of a member of another instance', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, owner)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(page.getByText('Far Member').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('.search-btn').click()
  const input = page.locator('.search-query-input')
  await expect(input).toBeVisible({ timeout: 10_000 })

  await input.fill('from:')
  const hints = page.locator('.search-option-hint')
  await expect(hints.filter({ hasText: `@${remote.username}@${DOMAIN}` })).toHaveCount(1, { timeout: 10_000 })
  await expect(hints.filter({ hasText: new RegExp(`^@${owner.username}$`) })).toHaveCount(1)
})
