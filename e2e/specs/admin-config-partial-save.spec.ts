// Journey: Admin › Configuration saves only what the admin changed. A switch stored on and
// never touched stays on after a save of another field; a value another admin stored after
// this page loaded is not reverted by this page's save. A value typed as soon as a slow load
// allows it is saved.
//
// instance_config is snapshotted before and restored after.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let staff: SpecUser
let snapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function readConfig(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  const value = data?.config_value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return value }
  }
  return value
}

test.beforeAll(async () => {
  const { data, error } = await admin.from('instance_config').select('config_key, config_value, description')
  if (error || !data) throw new Error(`snapshot: ${error?.message}`)
  snapshot = data
  staff = await createUser(admin, 'acps')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(promoteError.message)
})

test.afterAll(async () => {
  const { data: now } = await admin.from('instance_config').select('config_key')
  const added = (now ?? []).map((r) => r.config_key).filter((k) => !snapshot.some((s) => s.config_key === k))
  if (added.length) await admin.from('instance_config').delete().in('config_key', added)
  if (snapshot.length) await admin.from('instance_config').upsert(snapshot, { onConflict: 'config_key' })
  await deleteUser(admin, staff)
})

async function openGeneral(page: Page): Promise<void> {
  await page.goto('/admin?tab=config')
  await expect(page.locator('.config-tab-btn', { hasText: 'General' })).toBeVisible({ timeout: 30000 })
}

const serverSizeField = (page: Page) =>
  page.locator('.setting-group').filter({ hasText: 'Max server size' }).locator('input')

const CONFIG_READ_DELAY_MS = 3000

// AdminService.getInstanceConfig runs these three in series.
const isConfigRead = (method: string, url: string) =>
  url.includes('/rest/v1/rpc/get_public_federation_settings')
  || (method === 'GET' && url.includes('/rest/v1/instance_webrtc_settings'))
  || (method === 'GET' && url.includes('/rest/v1/instance_config') && url.includes('config_key=in.'))

async function save(page: Page): Promise<void> {
  await page.locator('.config-section').getByRole('button', { name: 'Save changes' }).first().click()
  await expect(page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Configuration saved' })).toBeVisible({ timeout: 20000 })
}

test('a save writes the edited field and leaves the switches as stored', async ({ page }) => {
  test.setTimeout(120_000)
  await setConfig('gif_clips_enabled', true)
  await setConfig('gif_ai_emojis_enabled', true)
  await setConfig('max_server_size', 1111)
  await signIn(page, staff)
  await openGeneral(page)
  await expect(serverSizeField(page)).toHaveValue('1111', { timeout: 20000 })

  await serverSizeField(page).fill('1234')
  await save(page)

  await expect.poll(() => readConfig('max_server_size')).toBe(1234)
  expect(await readConfig('gif_clips_enabled')).toBe(true)
  expect(await readConfig('gif_ai_emojis_enabled')).toBe(true)
})

test('a save does not revert a value stored after the page loaded', async ({ page }) => {
  test.setTimeout(120_000)
  await setConfig('gif_memes_enabled', false)
  await setConfig('max_server_size', 1111)
  await signIn(page, staff)
  await openGeneral(page)
  await expect(serverSizeField(page)).toHaveValue('1111', { timeout: 20000 })

  // Another admin turns memes on meanwhile.
  await setConfig('gif_memes_enabled', true)

  await serverSizeField(page).fill('1500')
  await save(page)

  await expect.poll(() => readConfig('max_server_size')).toBe(1500)
  expect(await readConfig('gif_memes_enabled')).toBe(true)
})

test('a value typed as soon as a slow load allows it is saved', async ({ page }) => {
  test.setTimeout(120_000)
  await setConfig('max_server_size', 1111)
  await signIn(page, staff)
  const delayed = new Set<string>()
  await page.route('**/rest/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (isConfigRead(route.request().method(), route.request().url())) {
      delayed.add(path)
      await new Promise((resolve) => setTimeout(resolve, CONFIG_READ_DELAY_MS))
    }
    await route.continue()
  })
  await openGeneral(page)

  // fill() acts when the field first accepts input.
  await serverSizeField(page).fill('1234', { timeout: 60000 })
  // Outlasts the reads, so a disabled Save means the load discarded the value.
  await expect(page.locator('.config-section').getByRole('button', { name: 'Save changes' }).first()).toBeEnabled({ timeout: 30000 })
  await expect(serverSizeField(page)).toHaveValue('1234')
  await save(page)

  await expect.poll(() => readConfig('max_server_size')).toBe(1234)
  expect(delayed.size).toBe(3)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('nothing can be edited or saved while the stored values are unread', async ({ page }) => {
  test.setTimeout(120_000)
  await setConfig('max_server_size', 1111)
  await signIn(page, staff)
  await page.route('**/rest/v1/instance_config*', (route) =>
    route.request().method() === 'GET' && route.request().url().includes('config_key=in.')
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' })
      : route.continue(),
  )
  await openGeneral(page)
  await expect(page.locator('.Vue-Toastification__toast--error').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('config-load-failed')).toBeVisible()
  await expect(serverSizeField(page)).toBeDisabled()
  await expect(page.locator('.config-section').getByRole('button', { name: 'Save changes' }).first()).toBeDisabled()

  // Saving branding from this state would write its defaults over the stored values.
  await page.locator('.config-tab-btn', { hasText: 'Branding' }).click()
  await expect(page.locator('.setting-group').filter({ hasText: 'Instance name' }).locator('input')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save branding' })).toBeDisabled()
  expect(await readConfig('max_server_size')).toBe(1111)
})
