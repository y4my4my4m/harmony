// Journey: a server on another instance refused a join after the join request had answered. The
// federation backend's processReject removes the membership and writes a 'server_join_rejected'
// notification; the inbox names the server and the reason it gave. The row is written here as the
// backend writes it (this stack has no federation backend); the live toast and the removal of the
// server from the list need Realtime, which this stack lacks (utils/joinRejected.ts unit tests).

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  reader = await createUser(admin, 'jrn')
  server = await seedServer(admin, reader, `Home ${reader.username}`)
  const { error } = await admin.from('notifications').insert({
    user_id: reader.id,
    type: 'server_join_rejected',
    data: {
      server: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Mastodon Canada', ap_id: 'https://chat.example/servers/aa' },
      reason: 'Federation is disabled on this server',
    },
  })
  if (error) throw new Error(error.message)
})

test.afterAll(async () => {
  await deleteUser(admin, reader)
})

test('the inbox names the server that refused the join and its reason', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)

  await page.locator('[data-testid="notification-bell"]').click()
  const panel = page.locator('[data-testid="notification-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })
  const item = panel.locator('[data-testid="notification-item"][data-type="server_join_rejected"]')
  await expect(item).toContainText('Mastodon Canada refused your join request', { timeout: 30000 })
  await expect(item).toContainText('Reason given: Federation is disabled on this server')
})
