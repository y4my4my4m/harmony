// Journey: sign-in through the instance's own OIDC provider (issue #173, migration 20261030800001).
// The provider is dex from e2e/stack.sh, registered the way `harmony auth add-provider` does it:
// GoTrue's admin API holds the client and its secret, instance_config.custom_oauth_providers the
// button. A new person signs in at dex and picks a username; a person whose account has the same
// address signs in to that account; an admin sees the provider, read-only, under Authentication.
//
// dex answers at E2E_IDP_ISSUER, https://idp.e2e.test:<port>/dex. The browser maps idp.e2e.test
// to 127.0.0.1 and accepts the stack's throwaway CA; GoTrue reaches dex on the stack network.
//
// The dex accounts are fixed per stack: each run removes what an earlier run left of them.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  instanceDomain,
  signIn,
  PASSWORD,
  type SpecUser,
} from './harness'

const IDP_HOST = process.env.E2E_IDP_HOST || 'idp.e2e.test'
test.use({
  serviceWorkers: 'block',
  ignoreHTTPSErrors: true,
  launchOptions: { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] },
})
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const PROVIDER = 'custom:e2e-dex'
const PROVIDER_NAME = 'E2E Dex'
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

async function forgetEmail(email: string): Promise<void> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  for (const user of data?.users ?? []) {
    if (user.email !== email) continue
    await admin.from('profiles').delete().eq('auth_user_id', user.id)
    await admin.auth.admin.deleteUser(user.id)
  }
}

/** The auth user with its identities, which GoTrue's user list leaves out. */
async function authUserByEmail(email: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const listed = data?.users?.find((u) => u.email === email)
  if (!listed) return undefined
  const { data: one } = await admin.auth.admin.getUserById(listed.id)
  return one?.user ?? undefined
}

/** The provider's button, its login form at dex, and back to the app. */
async function signInAtProvider(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  const button = page.getByRole('button', { name: `Continue with ${PROVIDER_NAME}` })
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

let linked: SpecUser
let staff: SpecUser

test.beforeAll(async () => {
  const newEmail = env('E2E_IDP_NEW_EMAIL')
  const linkEmail = env('E2E_IDP_LINK_EMAIL')
  await forgetEmail(newEmail)
  await forgetEmail(linkEmail)

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

  const { error } = await admin.from('instance_config').upsert(
    { config_key: 'custom_oauth_providers', config_value: [{ id: PROVIDER, name: PROVIDER_NAME }] },
    { onConflict: 'config_key' },
  )
  if (error) throw new Error(`instance_config: ${error.message}`)

  // An account that signed up with a password, at the address dex vouches for.
  const { data, error: userError } = await admin.auth.admin.createUser({
    email: linkEmail,
    password: PASSWORD,
    email_confirm: true,
  })
  if (userError || !data.user) throw new Error(`linked user: ${userError?.message}`)
  linked = {
    id: data.user.id,
    email: linkEmail,
    username: `linked${RUN}`.toLowerCase(),
    displayName: `Linked ${RUN}`,
    password: PASSWORD,
  }
  const { error: profileError } = await admin.from('profiles').insert({
    id: linked.id,
    auth_user_id: linked.id,
    username: linked.username,
    display_name: linked.displayName,
    is_local: true,
    domain: await instanceDomain(admin),
  })
  if (profileError) throw new Error(`linked profile: ${profileError.message}`)
  await admin.from('notification_preferences').upsert({ user_id: linked.id }, { onConflict: 'user_id' })

  staff = await createUser(admin, 'oidcadm')
  await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
})

test.afterAll(async () => {
  await gotrue('DELETE', `/admin/custom-providers/${PROVIDER}`)
  await admin.from('instance_config').update({ config_value: [] }).eq('config_key', 'custom_oauth_providers')
  await forgetEmail(env('E2E_IDP_NEW_EMAIL'))
  await deleteUser(admin, linked)
  await deleteUser(admin, staff)
})

test('a new person signs in through the instance provider and picks a username', async ({ page }) => {
  test.setTimeout(120_000)
  const username = `oidc${RUN}`.toLowerCase()

  await test.step('the provider button sits with the sign-in options and leads to its login', async () => {
    await signInAtProvider(page, env('E2E_IDP_NEW_EMAIL'))
  })

  await test.step('first sign-in asks for a profile, prefilled from the provider', async () => {
    await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
    await expect(page.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="profile-display-name"]')).toHaveValue('Ada Oidc')
    await page.locator('[data-testid="profile-username"]').fill(username)
    await expect(page.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="profile-submit"]').click()

    await expect(page).toHaveURL(/\/chat/, { timeout: 60000 })
    await dismissAnnouncements(page)
    await expect(page.locator('.user-profile .user-name')).toHaveText('Ada Oidc', { timeout: 30000 })
  })

  await test.step('the account is the provider identity, with its profile', async () => {
    const user = await authUserByEmail(env('E2E_IDP_NEW_EMAIL'))
    expect(user?.identities?.map((i) => i.provider)).toEqual([PROVIDER])
    const { data: profile } = await admin.from('profiles').select('username, auth_user_id')
      .eq('auth_user_id', user!.id).maybeSingle()
    expect(profile).toEqual({ username, auth_user_id: user!.id })
  })
})

test('an account with the address the provider verifies signs in as itself', async ({ page }) => {
  test.setTimeout(120_000)
  await signInAtProvider(page, linked.email)

  await expect(page).toHaveURL(/\/chat/, { timeout: 30000 })
  await dismissAnnouncements(page)
  await expect(page.locator('.user-profile .user-name')).toHaveText(linked.displayName, { timeout: 30000 })

  const user = await authUserByEmail(linked.email)
  expect(user?.id).toBe(linked.id)
  expect(user?.identities?.map((i) => i.provider).sort()).toEqual([PROVIDER, 'email'].sort())
})

test('the admin panel lists the provider and the callback, read-only', async ({ page }) => {
  await signIn(page, staff)
  await page.goto('/admin?tab=config')
  await dismissAnnouncements(page)
  await page.locator('.config-tab-btn').filter({ hasText: 'Authentication' }).click()

  const section = page.getByTestId('admin-custom-oauth')
  await expect(section.getByTestId('admin-custom-oauth-list')).toContainText(PROVIDER_NAME, { timeout: 15000 })
  await expect(section.getByTestId('admin-custom-oauth-list')).toContainText(PROVIDER)
  await expect(section.getByTestId('admin-custom-oauth-callback'))
    .toHaveText(`${env('E2E_SUPABASE_URL')}/auth/v1/callback`)
  await expect(section.locator('input, textarea, select')).toHaveCount(0)
})
