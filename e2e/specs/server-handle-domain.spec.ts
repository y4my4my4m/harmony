// Journey: Server settings › Privacy names a federated server's handle with the instance's
// handle domain (runtimeConfig.domain; in the native apps the chosen instance's), never the
// page's own host. The native apps' page host is tauri.localhost; here /config.json names a
// handle domain apart from the page's localhost.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const HANDLE_DOMAIN = 'handles.example'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let slug = ''

test.beforeAll(async () => {
  owner = await createUser(admin, 'hdom')
  server = await seedServer(admin, owner, `Handle ${owner.username}`)
  const { data, error } = await admin.from('servers').update({ federation_enabled: true }).eq('id', server.id).select('slug').single()
  if (error || !data?.slug) throw new Error(`federate ${server.name}: ${error?.message}`)
  slug = data.slug
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

test('the server handle names the instance handle domain, not the page host', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/config.json*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ domain: HANDLE_DOMAIN }) }),
  )
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=privacy`)
  await dismissAnnouncements(page)
  const handle = page.locator('.server-handle-card .handle-value')
  await expect(handle).toHaveText(`${slug}@${HANDLE_DOMAIN}`, { timeout: 30000 })
  await expect(page.locator('.server-handle-card').getByRole('button', { name: `Copy server handle ${slug}@${HANDLE_DOMAIN}` })).toBeVisible()
})
