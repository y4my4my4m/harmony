// Journey: registration per sign-in method (migration 20261126500001, federation-backend
// routes/adminInvites.ts, Admin > Invites).
//
// The instance's registration is closed. The sign-up page refuses an address with the closed
// text, and a first sign-in through the instance's own provider (dex, custom:*) that follows
// registration is refused on the callback page too. An admin limits the provider to an email
// domain on Admin > Invites: an address at another domain is refused, one at the listed domain
// creates the account. An invitation still makes an account while registration is closed. The
// Invites tab names the closed policy.
//
// The stack's GoTrue keeps its sign-up switch off (E2E_DISABLE_SIGNUP unset): the sign-up hook
// decides, as on a self-hosted instance where it runs. registration_policy is instance-wide, so
// the file runs serially and restores it; other specs signing up meanwhile on another worker
// would be refused. The dex account is fixed per stack; each run removes what an earlier run left.
import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'

const IDP_HOST = process.env.E2E_IDP_HOST || 'idp.e2e.test'
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'

test.use({
  serviceWorkers: 'block',
  ignoreHTTPSErrors: true,
  launchOptions: { args: [`--host-resolver-rules=MAP ${IDP_HOST} 127.0.0.1`] },
})
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const PROVIDER = 'custom:e2e-dex-methods'
const PROVIDER_NAME = 'E2E Dex Methods'
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const STRANGER = `methods${tag}@e2e.harmony.local`
const INVITEE = `methodsinv${tag}@e2e.harmony.local`

const CLOSED_TEXT = 'This instance is not taking new accounts.'
const OTHER_DOMAIN_TEXT =
  'New accounts through this sign-in are limited to some email domains, and this address is not at one of them.'

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
  await admin.from('instance_invites').delete().eq('auth_user_id', user.id)
  await admin.from('profiles').delete().eq('auth_user_id', user.id)
  await admin.auth.admin.deleteUser(user.id)
}

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function configValue(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  return data?.config_value ?? null
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

/** A provider sign-in in a context of its own, which keeps the admin's session out of it. */
async function providerSignIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block', ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await signInAtProvider(page, email)
  return page
}

async function setProviderOnPanel(page: Page, mode: 'follow' | 'open' | 'domains', domains = ''): Promise<void> {
  await page.goto('/admin?tab=invites')
  const card = page.getByTestId(`signup-provider-${PROVIDER}`)
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.getByTestId(`signup-provider-${mode}`).check()
  if (mode === 'domains') await card.getByTestId('signup-provider-domain-list').fill(domains)
  await page.getByTestId('signup-providers-save').click()
  // The button is disabled while saving too; the toast follows the write.
  await expect(page.getByText('Sign-up through providers saved')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('signup-providers-save')).toBeDisabled()
}

let staff: SpecUser
let backend: Backend
let snapshot: { policy: unknown; providers: unknown; buttons: unknown }

test.beforeAll(async () => {
  test.setTimeout(120_000)
  snapshot = {
    policy: await configValue('registration_policy'),
    providers: await configValue('signup_providers'),
    buttons: (await configValue('custom_oauth_providers')) ?? [],
  }
  staff = await createUser(admin, 'methadm')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(`promote admin: ${error.message}`)
  backend = await startBackend({ APP_URL: BASE_URL })

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
  await setConfig('signup_providers', {})
  await setConfig('registration_policy', 'closed')
})

test.afterAll(async () => {
  if (snapshot) {
    if (snapshot.policy === null) await admin.from('instance_config').delete().eq('config_key', 'registration_policy')
    else await setConfig('registration_policy', snapshot.policy)
    await setConfig('signup_providers', snapshot.providers ?? {})
    await setConfig('custom_oauth_providers', snapshot.buttons)
  }
  await backend?.stop()
  await gotrue('DELETE', `/admin/custom-providers/${PROVIDER}`)
  for (const email of [env('E2E_IDP_NEW_EMAIL'), STRANGER, INVITEE]) await forgetAccount(email)
  if (staff) await deleteUser(admin, staff)
})

test('the sign-up page refuses an address while registration is closed', async ({ page }) => {
  await page.goto('/register')
  await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
  await page.getByTestId('auth-email').fill(STRANGER)
  await page.getByTestId('auth-password').fill('methods-password-12345')
  await page.getByTestId('auth-submit').click()
  await expect(page.getByTestId('auth-form-error')).toHaveText(CLOSED_TEXT, { timeout: 30000 })
  expect(await accountAt(STRANGER)).toBeUndefined()
})

test('a provider that follows registration makes no account', async ({ browser }) => {
  const page = await providerSignIn(browser, env('E2E_IDP_NEW_EMAIL'))
  await expect(page).toHaveURL(/\/auth\/callback/)
  await expect(page.getByText(CLOSED_TEXT)).toBeVisible({ timeout: 30000 })
  expect(await accountAt(env('E2E_IDP_NEW_EMAIL'))).toBeUndefined()
  await page.context().close()
})

test('the Invites tab names the closed policy and lists the provider following it', async ({ page }) => {
  await backend.route(page)
  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  await expect(page.getByTestId('invites-registration')).toContainText('Registration: closed.', { timeout: 30000 })
  const card = page.getByTestId(`signup-provider-${PROVIDER}`)
  await expect(card).toBeVisible()
  await expect(page.getByRole('group', { name: PROVIDER_NAME })).toBeVisible()
  await expect(card.getByTestId('signup-provider-follow')).toBeChecked()
  await expect(page.getByTestId('signup-providers-switch-on')).toHaveCount(0)
})

test('a domain list refuses an address at another domain', async ({ page, browser }) => {
  await backend.route(page)
  await signIn(page, staff)
  await setProviderOnPanel(page, 'domains', 'MySchool.test\n')
  expect(await configValue('signup_providers')).toEqual({ [PROVIDER]: { mode: 'domains', domains: ['myschool.test'] } })

  const visitor = await providerSignIn(browser, env('E2E_IDP_NEW_EMAIL'))
  await expect(visitor).toHaveURL(/\/auth\/callback/)
  await expect(visitor.getByText(OTHER_DOMAIN_TEXT)).toBeVisible({ timeout: 30000 })
  expect(await accountAt(env('E2E_IDP_NEW_EMAIL'))).toBeUndefined()
  await visitor.context().close()
})

test('the panel refuses a list with something that is not a domain', async ({ page }) => {
  await backend.route(page)
  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  const card = page.getByTestId(`signup-provider-${PROVIDER}`)
  await card.getByTestId('signup-provider-domain-list').fill('myschool.test\nnot a domain')
  await page.getByTestId('signup-providers-save').click()
  await expect(page.getByTestId('signup-providers-error')).toHaveText('not is not a domain name.')
  await expect(card.getByTestId('signup-provider-domain-list')).toHaveAttribute('aria-invalid', 'true')
  expect(await configValue('signup_providers')).toEqual({ [PROVIDER]: { mode: 'domains', domains: ['myschool.test'] } })
})

test('an address the provider verified at a listed domain makes the account', async ({ page, browser }) => {
  await backend.route(page)
  await signIn(page, staff)
  await setProviderOnPanel(page, 'domains', 'e2e.harmony.local')

  const visitor = await providerSignIn(browser, env('E2E_IDP_NEW_EMAIL'))
  await expect(visitor).toHaveURL(/new-profile/, { timeout: 30000 })
  expect(await accountAt(env('E2E_IDP_NEW_EMAIL'))).toBeDefined()
  await visitor.context().close()

  // The account signs in again whatever the provider's setting.
  await setProviderOnPanel(page, 'follow')
  expect(await configValue('signup_providers')).toEqual({})
  const again = await providerSignIn(browser, env('E2E_IDP_NEW_EMAIL'))
  await expect(again).toHaveURL(/new-profile/, { timeout: 30000 })
  await again.context().close()
})

test('an invitation makes an account while registration is closed', async ({ page }) => {
  await backend.route(page)
  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  await page.getByTestId('invite-email').fill(INVITEE)
  await page.getByTestId('invite-create').click()
  await expect(page.getByTestId('invite-result')).toBeVisible({ timeout: 30000 })
  expect(await accountAt(INVITEE)).toBeDefined()
  const { count } = await admin.from('signup_invite_passes').select('email', { count: 'exact', head: true }).eq('email', INVITEE)
  expect(count).toBe(0)
})
