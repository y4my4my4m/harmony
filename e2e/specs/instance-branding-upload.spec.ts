// Journey: an instance admin uploads the instance icon and banner from Admin > Config > Branding
// (issue 142). Both go to `instance/` in server_icons and server_banners. The server owners'
// policies on those buckets cast the first folder to uuid, and 'instance' is not one, so every
// branding upload failed with "invalid input syntax for type uuid". A server owner's own icon
// upload still works; a non-admin's write to `instance/` is still refused.

import { test, expect } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const BRANDING_KEYS = ['instance_icon', 'instance_banner']

const admin = adminClient()
let staff: SpecUser
let owner: SpecUser
let server: SeededServer
let savedBranding: Array<{ config_key: string; config_value: unknown }> = []
const uploaded: Array<{ bucket: string; path: string }> = []

test.beforeAll(async () => {
  staff = await createUser(admin, 'brand')
  owner = await createUser(admin, 'bown')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  server = await seedServer(admin, owner, `Branding ${owner.username}`)
  const { data } = await admin.from('instance_config').select('config_key, config_value').in('config_key', BRANDING_KEYS)
  savedBranding = data ?? []
})

test.afterAll(async () => {
  await admin.from('instance_config').delete().in('config_key', BRANDING_KEYS)
  if (savedBranding.length) await admin.from('instance_config').insert(savedBranding)
  for (const bucket of ['server_icons', 'server_banners']) {
    const { data } = await admin.storage.from(bucket).list('instance')
    const mine = (data ?? []).map((o) => `instance/${o.name}`).filter((p) => uploaded.some((u) => u.bucket === bucket && u.path === p))
    if (mine.length) await admin.storage.from(bucket).remove(mine)
  }
  const { data: own } = await admin.storage.from('server_icons').list(server.id)
  if (own?.length) await admin.storage.from('server_icons').remove(own.map((o) => `${server.id}/${o.name}`))
  await deleteUser(admin, owner)
  await deleteUser(admin, staff)
})

test('an instance admin saves an uploaded icon and banner', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)
  await page.goto('/admin?tab=config')
  await dismissAnnouncements(page)
  await page.locator('.config-tab-btn').filter({ hasText: 'Branding' }).click()

  const section = page.locator('.config-section').filter({ hasText: 'Instance branding' })
  await expect(section).toBeVisible({ timeout: 15000 })
  await section.locator('input[type="file"]').nth(0).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: PNG })
  await section.locator('input[type="file"]').nth(1).setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG })

  // The banner uploads after the icon, and not at all once the icon fails.
  const upload = (bucket: string) => page
    .waitForResponse((r) => r.url().includes(`/storage/v1/object/${bucket}/instance/`) && r.request().method() === 'POST', { timeout: 30000 })
    .catch(() => null)
  const icon = upload('server_icons')
  const banner = upload('server_banners')
  await page.getByRole('button', { name: 'Save branding' }).click()
  for (const [bucket, pending] of [['server_icons', icon], ['server_banners', banner]] as const) {
    const res = await pending
    expect(res, `${bucket}: no upload request`).not.toBeNull()
    uploaded.push({ bucket, path: decodeURIComponent(new URL(res!.url()).pathname.split(`/object/${bucket}/`)[1]) })
    expect(res!.status(), `${bucket}: ${await res!.text()}`).toBe(200)
  }

  await expect.poll(async () => {
    const { data } = await admin.from('instance_config').select('config_key, config_value').in('config_key', BRANDING_KEYS)
    return Object.fromEntries((data ?? []).map((r) => [r.config_key, String(r.config_value)]))
  }, { timeout: 15000 }).toEqual({
    instance_icon: expect.stringContaining('/server_icons/instance/'),
    instance_banner: expect.stringContaining('/server_banners/instance/'),
  })
})

test("a server owner uploads their server's icon; a non-admin cannot write instance branding", async () => {
  const client = await userClient(owner)
  const ownPath = `${server.id}/icon-${Date.now()}.png`
  const own = await client.storage.from('server_icons').upload(ownPath, PNG, { contentType: 'image/png' })
  expect(own.error).toBeNull()

  for (const bucket of ['server_icons', 'server_banners']) {
    const path = `instance/spoof-${Date.now()}.png`
    const refused = await client.storage.from(bucket).upload(path, PNG, { contentType: 'image/png' })
    expect(refused.error?.message ?? '').toMatch(/row-level security/i)
  }
})
