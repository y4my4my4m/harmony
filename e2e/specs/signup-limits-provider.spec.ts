// Journey: a sign-up through an identity provider meets the network cap on GoTrue's /callback, and
// the refusal reaches the person on the app's callback page.
//
// The stack's only provider is dex, registered as an instance's own (custom:*), which is exempt
// unless signup_limit_own_providers is on. On, it takes the path Google, GitHub and Twitch take.
//
// extraHTTPHeaders names the client's network: a page.route handler is not called for the redirect
// from dex to /auth/v1/callback. Network from a random /56 of 2001:db8::/32; the dex account is fixed
// per stack, so each run removes what an earlier run left of it.

import { test, expect, type Page } from '@playwright/test'
import { adminClient } from './harness'

const IDP_HOST = process.env.E2E_IDP_HOST || 'idp.e2e.test'
const group = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16)
const PREFIX = `2001:db8:${group()}:${(1 + Math.floor(Math.random() * 0xfe)).toString(16)}00`
const NETWORK = `${PREFIX}::/56`

test.use({
  serviceWorkers: 'block',
  ignoreHTTPSErrors: true,
  launchOptions: { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] },
  extraHTTPHeaders: { 'x-e2e-client-ip': `${PREFIX}::1` },
})
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const PROVIDER = 'custom:e2e-dex-limits'
const PROVIDER_NAME = 'E2E Dex Limits'
const NETWORK_TEXT =
  'Too many accounts were created from this network today. Try again tomorrow, or ask this instance\'s admin for an invitation.'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set - run: npm run e2e:up`)
  return value
}

async function gotrue(method: string, path: string, body?: unknown): Promise<Response> {
  const key = env('E2E_SUPABASE_SERVICE_ROLE_KEY')
  return fetch(`${env('E2E_SUPABASE_URL')}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function accountAt(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  return (data?.users ?? []).find((user) => user.email === email)
}

async function forgetAccount(email: string): Promise<void> {
  const user = await accountAt(email)
  if (!user) return
  await admin.from('profiles').delete().eq('auth_user_id', user.id)
  await admin.auth.admin.deleteUser(user.id)
}

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function signInAtProvider(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  const button = page.getByRole('button', { name: `Continue with ${PROVIDER_NAME}`, exact: true })
  await expect(button).toBeVisible({ timeout: 30000 })
  await button.click()
  await page.waitForURL((url) => url.hostname === IDP_HOST, { timeout: 30000 })
  await page.locator('input[name="login"]').fill(email)
  await page.locator('input[name="password"]').fill(env('E2E_IDP_PASSWORD'))
  await page.locator('button[type="submit"]').click()
  await page.waitForURL((url) => url.hostname === 'localhost' && !url.pathname.startsWith('/auth/v1'), {
    timeout: 30000,
  })
}

let snapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []
let providers: unknown

test.beforeAll(async () => {
  const { data, error } = await admin
    .from('instance_config')
    .select('config_key, config_value, description')
    .like('config_key', 'signup\\_%')
  if (error || !data?.length) throw new Error(`snapshot: ${error?.message}`)
  snapshot = data
  const { data: current } = await admin
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'custom_oauth_providers')
    .maybeSingle()
  providers = current?.config_value ?? []

  await forgetAccount(env('E2E_IDP_NEW_EMAIL'))
  await gotrue('DELETE', `/admin/custom-providers/${PROVIDER}`)
  const created = await gotrue('POST', '/admin/custom-providers', {
    provider_type: 'oidc',
    identifier: PROVIDER,
    name: PROVIDER_NAME,
    client_id: env('E2E_IDP_CLIENT_ID'),
    client_secret: env('E2E_IDP_CLIENT_SECRET'),
    issuer: env('E2E_IDP_ISSUER'),
    scopes: ['openid', 'email', 'profile'],
  })
  if (created.status !== 201) throw new Error(`custom provider: HTTP ${created.status} ${await created.text()}`)
  await setConfig('custom_oauth_providers', [{ id: PROVIDER, name: PROVIDER_NAME }])

  await setConfig('signup_limits_enabled', true)
  await setConfig('signup_daily_ip_cap', 1)
  await setConfig('signup_enforce_caps', true)
  const { error: ledgerError } = await admin.from('signup_ledger').insert({ network: NETWORK })
  if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`)
})

test.afterAll(async () => {
  if (snapshot.length) await admin.from('instance_config').upsert(snapshot, { onConflict: 'config_key' })
  await setConfig('custom_oauth_providers', providers)
  await gotrue('DELETE', `/admin/custom-providers/${PROVIDER}`)
  await forgetAccount(env('E2E_IDP_NEW_EMAIL'))
})

test('a provider sign-up from a full network is refused on the callback page', async ({ page }) => {
  await setConfig('signup_limit_own_providers', true)
  await signInAtProvider(page, env('E2E_IDP_NEW_EMAIL'))

  await expect(page).toHaveURL(/\/auth\/callback/)
  await expect(page.getByText(NETWORK_TEXT)).toBeVisible({ timeout: 30000 })
  expect(await accountAt(env('E2E_IDP_NEW_EMAIL'))).toBeUndefined()
})

test('the instance\'s own provider passes while it is not counted', async ({ page }) => {
  await setConfig('signup_limit_own_providers', false)
  await signInAtProvider(page, env('E2E_IDP_NEW_EMAIL'))

  await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
  expect(await accountAt(env('E2E_IDP_NEW_EMAIL'))).toBeDefined()
})
