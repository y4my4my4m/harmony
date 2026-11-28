// Journey: sign-in through the instance's own OIDC provider when the provider sends the address
// from userinfo only (issue #173, Better Auth). OIDC Core 5.4 lets a provider keep the email and
// profile claims out of the ID token; GoTrue 2.197.0's OIDC type reads the ID token alone and never
// asks userinfo, so such a sign-in ends in "Error getting user email from external provider".
//
// `harmony auth add-provider --issuer` stores the provider as GoTrue's OAuth 2.0 type with the
// endpoints of the issuer's discovery document; --id-token keeps the OIDC type; --userinfo makes a
// stored OIDC provider again as OAuth 2.0 under the same identifier. Providers here are added by
// admin.sh's own node programs (adminProgram.ts).
//
// The provider is e2e/idp-userinfo.mjs at E2E_IDP_USERINFO_ISSUER: its ID token carries sub only.
// The browser maps idp.e2e.test to 127.0.0.1 and accepts the stack's throwaway CA; GoTrue reaches
// it on the stack network.

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, dismissAnnouncements } from './harness'
import { runAdminProgram } from './adminProgram'

const IDP_HOST = process.env.E2E_IDP_HOST || 'idp.e2e.test'
test.use({
  serviceWorkers: 'block',
  ignoreHTTPSErrors: true,
  launchOptions: { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] },
})
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const USERINFO = 'custom:e2e-userinfo'
const USERINFO_NAME = 'E2E Userinfo'
const ID_TOKEN = 'custom:e2e-idtoken'
const ID_TOKEN_NAME = 'E2E Token Only'
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

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

async function storedProvider(id: string): Promise<Record<string, any> | undefined> {
  const res = await gotrue('GET', '/admin/custom-providers')
  return ((await res.json()).providers as Record<string, any>[]).find((p) => p.identifier === id)
}

async function forgetEmail(email: string): Promise<void> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  for (const user of data?.users ?? []) {
    if (user.email !== email) continue
    await admin.from('profiles').delete().eq('auth_user_id', user.id)
    await admin.auth.admin.deleteUser(user.id)
  }
}

async function authUserByEmail(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const listed = data?.users?.find((u) => u.email === email)
  if (!listed) return undefined
  return (await admin.auth.admin.getUserById(listed.id)).data?.user ?? undefined
}

/** Requests the provider served, as "METHOD path" under the issuer. */
function idpRequests(): Promise<string[]> {
  const issuer = new URL(env('E2E_IDP_USERINFO_ISSUER'))
  return new Promise((resolve, reject) => {
    https.get({
      host: '127.0.0.1',
      port: Number(issuer.port),
      path: `${issuer.pathname}/_requests`,
      servername: IDP_HOST,
      headers: { Host: issuer.host },
      ca: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../idp/ca.pem')),
    }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

/** The requests the provider serves while FN runs. */
async function servedDuring(fn: () => Promise<void>): Promise<string[]> {
  const before = (await idpRequests()).length
  await fn()
  return (await idpRequests()).slice(before)
}

/** add-provider ID --name NAME --issuer ISSUER --client-id C [OPTIONS] with the secret given. */
function addProvider(id: string, params: Record<string, string>) {
  return runAdminProgram(['NODE_PROVIDER_LIB', 'NODE_PROVIDER_ADD'], {
    id,
    client_secret: env('E2E_IDP_CLIENT_SECRET'),
    ...params,
  })
}

async function signInAtProvider(page: Page, email: string, providerName: string): Promise<void> {
  await page.goto('/login')
  const button = page.getByRole('button', { name: `Continue with ${providerName}`, exact: true })
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

async function pickUsername(page: Page, displayName: string, username: string): Promise<void> {
  await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
  await expect(page.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="profile-display-name"]')).toHaveValue(displayName)
  await page.locator('[data-testid="profile-username"]').fill(username)
  await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
  await page.locator('[data-testid="profile-submit"]').click()
  await expect(page).toHaveURL(/\/chat/, { timeout: 60000 })
  await dismissAnnouncements(page)
  await expect(page.locator('.user-profile .user-name')).toHaveText(displayName, { timeout: 30000 })
}

async function clearProviders(): Promise<void> {
  await gotrue('DELETE', `/admin/custom-providers/${USERINFO}`)
  await gotrue('DELETE', `/admin/custom-providers/${ID_TOKEN}`)
  await admin.from('instance_config').upsert(
    { config_key: 'custom_oauth_providers', config_value: [] },
    { onConflict: 'config_key' },
  )
}

test.beforeAll(async () => {
  await forgetEmail(env('E2E_IDP_USERINFO_NEW_EMAIL'))
  await forgetEmail(env('E2E_IDP_USERINFO_SWITCH_EMAIL'))
  await clearProviders()

  const issuer = env('E2E_IDP_USERINFO_ISSUER')
  const common = { source: 'issuer', issuer, client_id: env('E2E_IDP_CLIENT_ID') }
  const byDefault = await addProvider(USERINFO, { ...common, name: USERINFO_NAME })
  expect(byDefault, byDefault.error).toMatchObject({ ok: true, reads: 'userinfo', created: true })
  const idToken = await addProvider(ID_TOKEN, { ...common, name: ID_TOKEN_NAME, claims: 'id_token' })
  expect(idToken, idToken.error).toMatchObject({ ok: true, reads: 'id_token', created: true })
})

test.afterAll(async () => {
  await clearProviders()
  await forgetEmail(env('E2E_IDP_USERINFO_NEW_EMAIL'))
  await forgetEmail(env('E2E_IDP_USERINFO_SWITCH_EMAIL'))
})

test('read from the ID token, the provider ends the sign-in without an address', async ({ page }) => {
  test.setTimeout(120_000)
  const served = await servedDuring(async () => {
    await signInAtProvider(page, env('E2E_IDP_USERINFO_SWITCH_EMAIL'), ID_TOKEN_NAME)
    await expect(page.getByText(/Error.getting.user.email.from.external.provider/)).toBeVisible({ timeout: 30000 })
  })
  expect(served).toContain('POST /oauth2/token')
  expect(served).not.toContain('GET /oauth2/userinfo')
  expect(await authUserByEmail(env('E2E_IDP_USERINFO_SWITCH_EMAIL'))).toBeUndefined()
})

test('added by default, the provider reads userinfo: a new person signs in and picks a username', async ({ page }) => {
  test.setTimeout(120_000)
  expect(await storedProvider(USERINFO)).toMatchObject({
    provider_type: 'oauth2',
    userinfo_url: `${env('E2E_IDP_USERINFO_ISSUER')}/oauth2/userinfo`,
    scopes: ['openid', 'email', 'profile'],
  })

  const served = await servedDuring(async () => {
    await signInAtProvider(page, env('E2E_IDP_USERINFO_NEW_EMAIL'), USERINFO_NAME)
    await pickUsername(page, 'Una Userinfo', `una${RUN}`.toLowerCase())
  })
  expect(served).toContain('GET /oauth2/userinfo')

  const user = await authUserByEmail(env('E2E_IDP_USERINFO_NEW_EMAIL'))
  expect(user?.identities?.map((i) => i.provider)).toEqual([USERINFO])
})

test('--userinfo makes the ID token provider read userinfo, and the person it refused gets in', async ({ page }) => {
  test.setTimeout(120_000)
  const switched = await runAdminProgram(['NODE_PROVIDER_LIB', 'NODE_PROVIDER_ADD'], {
    id: ID_TOKEN,
    claims: 'userinfo',
    client_secret: env('E2E_IDP_CLIENT_SECRET'),
  })
  expect(switched, switched.error).toMatchObject({ ok: true, reads: 'userinfo', replaced: true, created: false })
  expect(await storedProvider(ID_TOKEN)).toMatchObject({ provider_type: 'oauth2', name: ID_TOKEN_NAME })

  const listed = await runAdminProgram(['NODE_PROVIDER_LIB', 'NODE_PROVIDER_LIST'], {})
  const rows = Buffer.from(listed.rows, 'base64').toString('utf8').split('\n')
  expect(rows).toContain(`${ID_TOKEN}\t${ID_TOKEN_NAME}\tuserinfo\tshown\t${env('E2E_IDP_USERINFO_ISSUER')}/oauth2/authorize`)

  await signInAtProvider(page, env('E2E_IDP_USERINFO_SWITCH_EMAIL'), ID_TOKEN_NAME)
  await pickUsername(page, 'Sid Switch', `sid${RUN}`.toLowerCase())
  const user = await authUserByEmail(env('E2E_IDP_USERINFO_SWITCH_EMAIL'))
  expect(user?.identities?.map((i) => i.provider)).toEqual([ID_TOKEN])
})
