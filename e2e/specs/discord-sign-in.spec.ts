// Journey: Discord sign-in set up from Admin, Authentication (migration 20261117800001).
// The admin saves the Discord application's client id and secret; the federation server's writer
// (e2e/auth-config-writer.ts) renders them into the stack GoTrue's --config-dir; GoTrue reloads
// without a restart and the sign-in page sends people to Discord with that client. Discord itself
// is never reached: the browser's requests to discord.com are answered here.

import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { startAuthConfigWriter, type AuthConfigWriter } from './authConfigWriter'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const CLIENT_ID = '123456789012345678'
const SECRET = 'e2e-discord_Secret.0123'
const SETTLE_MS = 45_000

let staff: SpecUser
let writer: AuthConfigWriter
let savedButtons: unknown

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

/** GoTrue's GET /auth/v1/settings: whether the running sign-in service has Discord on. */
async function discordRunning(): Promise<boolean> {
  const res = await fetch(`${env('E2E_SUPABASE_URL')}/auth/v1/settings`, {
    headers: { apikey: env('E2E_SUPABASE_ANON_KEY') },
  })
  return ((await res.json()) as { external?: Record<string, boolean> }).external?.discord === true
}

/**
 * Discord off in the running sign-in service. The row stays, cleared: GoTrue's reload never unsets
 * a key, so only a written ENABLED=false turns off what an earlier run turned on.
 */
async function turnDiscordOff(): Promise<void> {
  await admin.from('auth_provider_credentials').upsert({ provider: 'discord', client_id: null, secret_id: null })
  await expect.poll(discordRunning, { timeout: SETTLE_MS, intervals: [1000] }).toBe(false)
}

async function openAuthentication(page: Page) {
  await signIn(page, staff)
  await page.goto('/admin?tab=config')
  await dismissAnnouncements(page)
  await page.locator('.config-tab-btn').filter({ hasText: 'Authentication' }).click()
  const card = page.getByTestId('sip-discord')
  await expect(card).toBeVisible({ timeout: 15000 })
  return card
}

test.beforeAll(async () => {
  test.setTimeout(90_000)
  staff = await createUser(admin, 'discadm')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'oauth_providers').maybeSingle()
  savedButtons = data?.config_value ?? []
  await admin.from('instance_config').update({ config_value: [] }).eq('config_key', 'oauth_providers')
  writer = await startAuthConfigWriter()
  await turnDiscordOff()
})

test.afterAll(async () => {
  test.setTimeout(90_000)
  if (writer) await turnDiscordOff().finally(() => writer.stop())
  await admin.from('instance_config').update({ config_value: savedButtons }).eq('config_key', 'oauth_providers')
  await deleteUser(admin, staff)
})

test('an admin turns on Discord sign-in without touching the server', async ({ page }) => {
  test.setTimeout(120_000)
  const card = await openAuthentication(page)
  const status = card.getByTestId('sip-status')
  await expect(status).toHaveText('Not set up', { timeout: 15000 })
  await expect(page.getByTestId('sip-callback')).toHaveText(`${env('E2E_SUPABASE_URL')}/auth/v1/callback`)

  await card.getByTestId('sip-client-id').fill('my-discord-app')
  await card.getByTestId('sip-secret').fill(SECRET)
  await card.getByTestId('sip-save').click()
  await expect(card.getByTestId('sip-problem')).toHaveText('A Discord client ID is the application ID: 17 to 20 digits.')

  await card.getByTestId('sip-client-id').fill(CLIENT_ID)
  await card.getByTestId('sip-save').click()
  await expect(page.getByText('Discord credentials saved')).toBeVisible({ timeout: 15000 })
  await expect(card.getByTestId('sip-secret')).toHaveValue('')
  await expect(card.getByTestId('sip-secret')).toHaveAttribute('placeholder', 'Saved. Type a new one to replace it.')
  // The button is hidden: the provider stays off in the sign-in service.
  await expect(status).toHaveText('Off: hidden from the sign-in page')

  // Keyboard: the switch's input is visually hidden, and the saved toast covers the card's corner.
  const toggle = card.getByRole('checkbox', { name: 'Show Discord on the sign-in page' })
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).toBeChecked()
  await expect(page.getByText('Sign-in page updated')).toBeVisible({ timeout: 15000 })
  await expect(status).toHaveText('Active', { timeout: SETTLE_MS })
  expect(await discordRunning()).toBe(true)

  const file = path.join(env('E2E_AUTH_CONFIG_DIR'), '50-harmony-oauth.env')
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
    "GOTRUE_EXTERNAL_DISCORD_ENABLED='true'",
    `GOTRUE_EXTERNAL_DISCORD_CLIENT_ID='${CLIENT_ID}'`,
    `GOTRUE_EXTERNAL_DISCORD_SECRET='${SECRET}'`,
    `GOTRUE_EXTERNAL_DISCORD_REDIRECT_URI='${env('E2E_SUPABASE_URL')}/auth/v1/callback'`,
  ])

  // The browser never receives the secret.
  await page.reload()
  await page.locator('.config-tab-btn').filter({ hasText: 'Authentication' }).click()
  await expect(card.getByTestId('sip-client-id')).toHaveValue(CLIENT_ID, { timeout: 15000 })
  expect(await page.content()).not.toContain(SECRET)
})

test('the sign-in page sends people to Discord with that application', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  // GoTrue answers /authorize with a redirect to Discord. A route never sees the redirected
  // request, so the redirect is read here and the browser stays on this side.
  let authorize: URL | null = null
  await context.route('**/discord.com/**', (route) => route.abort())
  await context.route('**/auth/v1/authorize?**', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 })
    const location = response.headers()['location']
    if (location) authorize = new URL(location)
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Redirected</title>' })
  })
  await page.goto('/login')
  const button = page.getByRole('button', { name: 'Continue with Discord' })
  await expect(button).toBeVisible({ timeout: 30000 })
  await button.click()
  await expect.poll(() => authorize?.pathname ?? '', { timeout: 15000 }).toBe('/api/oauth2/authorize')
  const url = authorize as unknown as URL
  expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
  expect(url.searchParams.get('redirect_uri')).toBe(`${env('E2E_SUPABASE_URL')}/auth/v1/callback`)
  expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'identify'])
  await context.close()
})

test('clearing the credentials turns Discord sign-in off', async ({ page }) => {
  test.setTimeout(120_000)
  const card = await openAuthentication(page)
  await expect(card.getByTestId('sip-status')).toHaveText('Active', { timeout: 15000 })
  await card.getByTestId('sip-clear').click()
  const dialog = page.getByRole('alertdialog', { name: 'Clear Discord sign-in?' })
  await dialog.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByText('Discord credentials cleared')).toBeVisible({ timeout: 15000 })
  await expect(card.getByTestId('sip-status')).toHaveText('Not set up', { timeout: SETTLE_MS })
  expect(await discordRunning()).toBe(false)
  await expect(card.getByTestId('sip-clear')).toHaveCount(0)

  const { data } = await admin.from('auth_provider_credentials').select('client_id, secret_id').eq('provider', 'discord').single()
  expect(data).toEqual({ client_id: null, secret_id: null })
})
