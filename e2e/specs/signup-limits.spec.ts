// Journey: instance sign-up limits. The network and domain caps observe by default; this spec turns
// signup_enforce_caps on and tests observing in a test of its own.
//
// The stack's GoTrue runs public.before_user_created_hook and reads Sb-Forwarded-For, as a real
// instance does. e2e/gateway.conf overwrites that header from X-E2E-Client-IP, which stands in
// for the address a real proxy sees, so a spec names its client's network. A request without
// X-E2E-Client-IP comes from a private docker address and is exempt: that is every other spec's
// sign-up, and an instance's own invitations.
//
// Addresses are random /56s of 2001:db8::/32: ledger rows of an earlier run on the same stack
// count for 24 hours. The signup_* keys of instance_config are snapshotted before and restored
// after; other keys belong to specs that may run alongside.

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, loadApp, seedServer, signIn, PASSWORD, type SpecUser } from './harness'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? ''
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.TEST_SUPABASE_ANON_KEY ?? ''

const NETWORK_TEXT =
  'Too many accounts were created from this network today. Try again tomorrow, or ask this instance\'s admin for an invitation.'
const DOMAIN_CAP_TEXT =
  'Too many accounts were created with this email domain today. Try again tomorrow, or ask this instance\'s admin for an invitation.'
const INBOX_TEXT = 'This email inbox has reached the limit of accounts on this instance.'
const DOMAIN_TEXT = 'This email provider cannot be used to sign up on this instance. Use another address.'

function randomNetwork(): { address: string; cidr: string } {
  const group = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16)
  const prefix = `2001:db8:${group()}:${(1 + Math.floor(Math.random() * 0xfe)).toString(16)}00`
  return { address: `${prefix}::1`, cidr: `${prefix}::/56` }
}

const admin = adminClient()
const NETWORK_A = randomNetwork()
const NETWORK_B = randomNetwork()
const NETWORK_C = randomNetwork()
const BLOCKED_DOMAIN = `blocked-${RUN}.example`
const mailbox = (tag = '') => `${RUN}${tag}@e2e.harmony.local`
const stranger = (name: string) => `${RUN}${name}@e2e.harmony.local`

let staff: SpecUser
let snapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function readConfig(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  return data?.config_value
}

/** The federation worker's answer; this stack runs no worker. */
async function setMailHosts(domain: string, hosts: string[]): Promise<void> {
  const { error } = await admin
    .from('signup_mail_hosts')
    .upsert({ domain, hosts, checked_at: new Date().toISOString(), due_at: null }, { onConflict: 'domain' })
  if (error) throw new Error(`${domain}: ${error.message}`)
}

async function accountExists(email: string): Promise<boolean> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  return (data?.users ?? []).some((u) => u.email === email)
}

/** The /register form in a browser context of its own. `address` is the network it posts from. */
interface RegisterForm {
  page: Page
  address: string
}

async function openRegister(browser: Browser, address: string): Promise<RegisterForm> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const form: RegisterForm = { page, address }
  await page.route('**/auth/v1/signup**', async (route) => {
    await route.continue({ headers: { ...route.request().headers(), 'x-e2e-client-ip': form.address } })
  })
  await loadApp(page, '/register', page.locator('[data-testid="auth-email"]'))
  return form
}

async function submitRegistration(page: Page, email: string): Promise<void> {
  await page.locator('[data-testid="auth-email"]').fill(email)
  await page.locator('[data-testid="auth-password"]').fill(PASSWORD)
  const answered = page.waitForResponse((r) => r.url().includes('/auth/v1/signup') && r.request().method() === 'POST', {
    timeout: 30000,
  })
  await page.locator('[data-testid="auth-submit"]').click()
  await answered
}

/** A signed-up session leaves the form: each accepted account takes a new context. */
async function expectAccepted(browser: Browser, address: string, email: string): Promise<void> {
  const { page } = await openRegister(browser, address)
  await submitRegistration(page, email)
  await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
  await page.context().close()
  expect(await accountExists(email)).toBe(true)
}

async function expectRefused(form: RegisterForm, address: string, email: string, text: string): Promise<void> {
  form.address = address
  await submitRegistration(form.page, email)
  await expect(form.page.locator('[data-testid="auth-form-error"]')).toHaveText(text, { timeout: 15000 })
  await expect(form.page).toHaveURL(/register/)
  expect(await accountExists(email)).toBe(false)
}

async function postSignup(
  request: APIRequestContext,
  body: { email: string; password: string },
  headers: Record<string, string>,
) {
  return request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: ANON_KEY, 'content-type': 'application/json', ...headers },
    data: body,
  })
}

async function signUpThroughApi(request: APIRequestContext, address: string, email: string) {
  const response = await postSignup(request, { email, password: PASSWORD }, { 'x-e2e-client-ip': address })
  return { status: response.status(), msg: (await response.json()).msg as string | undefined }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const { data, error } = await admin
    .from('instance_config')
    .select('config_key, config_value, description')
    .like('config_key', 'signup\\_%')
  if (error || !data?.length) throw new Error(`snapshot: ${error?.message}`)
  snapshot = data
  await setConfig('signup_limits_enabled', true)
  await setConfig('signup_daily_ip_cap', 2)
  await setConfig('signup_mailbox_cap', 2)
  await setConfig('signup_daily_domain_cap', 0)
  await setConfig('signup_enforce_caps', true)
  await setConfig('signup_block_disposable_email', true)
  await setConfig('signup_blocked_email_domains', [])
  await setConfig('signup_blocked_mail_hosts', [])
  await setConfig('signup_trusted_email_domains', [])

  staff = await createUser(admin, 'siglimit')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(promoteError.message)
})

test.afterAll(async () => {
  if (snapshot.length) await admin.from('instance_config').upsert(snapshot, { onConflict: 'config_key' })
  await deleteUser(admin, staff)
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  for (const user of data?.users ?? []) {
    if (user.email?.startsWith(RUN)) await admin.auth.admin.deleteUser(user.id)
  }
})

test('a second account passes; bulk creation from one network is refused', async ({ browser }) => {
  test.setTimeout(180_000)

  await test.step('a first account', async () => {
    await expectAccepted(browser, NETWORK_A.address, mailbox())
  })

  await test.step('the same person opens a second account on an alias', async () => {
    await expectAccepted(browser, NETWORK_A.address, mailbox('+second'))
  })

  await test.step('the ledger holds the proxied network', async () => {
    const { count } = await admin
      .from('signup_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('network', NETWORK_A.cidr)
    expect(count).toBe(2)
  })

  const form = await openRegister(browser, NETWORK_A.address)

  await test.step('the next one from that network is refused, with a stranger\'s address', async () => {
    await expectRefused(form, NETWORK_A.address, stranger('third'), NETWORK_TEXT)
  })

  await test.step('a further alias of a full inbox is refused from any network', async () => {
    await expectRefused(form, NETWORK_B.address, mailbox('+third'), INBOX_TEXT)
  })

  await test.step('a disposable address is refused', async () => {
    await expectRefused(form, NETWORK_C.address, `${RUN}@mailinator.com`, DOMAIN_TEXT)
    await expectRefused(form, NETWORK_C.address, `${RUN}@mail.yopmail.com`, DOMAIN_TEXT)
  })

  await form.page.context().close()

  await test.step('another network still signs up', async () => {
    await expectAccepted(browser, NETWORK_B.address, stranger('fourth'))
  })
})

test('a client cannot name its own address', async ({ request }) => {
  const email = stranger('spoof')
  for (const forged of ['203.0.113.60', '198.51.100.61']) {
    const response = await postSignup(
      request,
      { email, password: PASSWORD },
      {
        'x-e2e-client-ip': NETWORK_A.address,
        'X-Forwarded-For': forged,
        'X-Real-IP': forged,
        'Sb-Forwarded-For': forged,
      },
    )
    expect(response.status()).toBe(429)
    expect((await response.json()).msg).toBe(NETWORK_TEXT)
  }
  expect(await accountExists(email)).toBe(false)
})

test('a request of the instance itself is not limited', async ({ request }) => {
  const email = `${RUN}internal@mailinator.com`
  const response = await postSignup(request, { email, password: PASSWORD }, {})
  expect(response.status()).toBe(200)
  expect(await accountExists(email)).toBe(true)
})

test('GoTrue\'s per-IP limiter keys on the proxied address', async ({ request }) => {
  const weak = { email: `${RUN}weak@e2e.harmony.local`, password: 'x' }
  const limited = randomNetwork().address

  // RATE_LIMIT_OTP default: 30 per 5 minutes, burst 30. A weak password never makes an account.
  const statuses: number[] = []
  for (let i = 0; i < 31; i++) {
    statuses.push((await postSignup(request, weak, { 'x-e2e-client-ip': limited })).status())
  }
  expect(statuses.slice(0, 30).every((status) => status === 422)).toBe(true)
  expect(statuses[30]).toBe(429)

  const other = await postSignup(request, weak, { 'x-e2e-client-ip': randomNetwork().address })
  expect(other.status()).toBe(422)
})

test('one operator with many mailboxes on one domain is refused from any network', async ({ browser, request }) => {
  test.setTimeout(120_000)
  const domain = `operator-${RUN}.example`
  await setConfig('signup_daily_domain_cap', 2)
  try {
    expect((await signUpThroughApi(request, randomNetwork().address, `a@${domain}`)).status).toBe(200)
    expect((await signUpThroughApi(request, randomNetwork().address, `b@${domain}`)).status).toBe(200)

    const form = await openRegister(browser, randomNetwork().address)
    await expectRefused(form, randomNetwork().address, `c@${domain}`, DOMAIN_CAP_TEXT)
    await form.page.context().close()

    // A large provider is many unrelated people. Refused here only if it were counted.
    for (const name of ['x', 'y', 'z']) {
      const { status } = await signUpThroughApi(request, randomNetwork().address, `${RUN}${name}@gmail.com`)
      expect(status).toBe(200)
    }
  } finally {
    await setConfig('signup_daily_domain_cap', 0)
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const user of data?.users ?? []) {
      if (user.email?.endsWith(`@${domain}`)) await admin.auth.admin.deleteUser(user.id)
    }
  }
})

test('password sign-in meets the per-IP limiter; a token refresh never does', async ({ request }) => {
  const address = randomNetwork().address
  const post = (query: string, body: string, contentType = 'application/json') =>
    request.post(`${SUPABASE_URL}/auth/v1/token?${query}`, {
      headers: { apikey: ANON_KEY, 'content-type': contentType, 'x-e2e-client-ip': address },
      data: body,
    })

  await test.step('a refresh with a bad token answers 4xx, never 429', async () => {
    for (let i = 0; i < 45; i++) {
      const response = await post('grant_type=refresh_token', JSON.stringify({ refresh_token: 'not-a-token' }))
      expect(response.status()).not.toBe(429)
      expect(response.status()).toBeLessThan(500)
    }
  })

  await test.step('the refresh query cannot carry a password sign-in past the limiter', async () => {
    const credentials = { email: staff.email, password: staff.password }
    for (const response of [
      await post('grant_type=refresh_token', JSON.stringify(credentials)),
      await post(
        'grant_type=refresh_token',
        new URLSearchParams({ grant_type: 'password', ...credentials }).toString(),
        'application/x-www-form-urlencoded',
      ),
    ]) {
      expect(response.ok()).toBe(false)
      expect(await response.text()).not.toContain('access_token')
    }
  })

  await test.step('wrong passwords from one address reach 429', async () => {
    // Burst 30, refilling at e2e/docker-compose.yml's RATE_LIMIT_TOKEN_REFRESH of 10000 per 5 minutes
    // (33 per second): a sequential loop on a loaded host stays under it.
    const statuses = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const response = await post(
          'grant_type=password',
          JSON.stringify({ email: `${RUN}nobody@e2e.harmony.local`, password: 'wrong-password' }),
        )
        return response.status()
      }),
    )
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
    expect(statuses.filter((status) => status === 400).length).toBeGreaterThanOrEqual(30)
    expect(statuses.filter((status) => status !== 429 && status !== 400)).toEqual([])
  })
})

test('observing, an account past the two caps is allowed and counted', async ({ request }) => {
  const domain = `campus-${RUN}.example`
  const network = randomNetwork().address
  const counts = async () => {
    const { data } = await admin.from('signup_refusal_counts').select('reason, refusals, would_refuse')
    const sum = (reason: string, column: 'refusals' | 'would_refuse') =>
      (data ?? []).filter((r) => r.reason === reason).reduce((total, r) => total + r[column], 0)
    return {
      wouldNetwork: sum('ip_cap', 'would_refuse'),
      wouldDomain: sum('domain_cap', 'would_refuse'),
      refusedNetwork: sum('ip_cap', 'refusals'),
      refusedDomain: sum('domain_cap', 'refusals'),
    }
  }

  await setConfig('signup_enforce_caps', false)
  await setConfig('signup_daily_domain_cap', 1)
  try {
    const before = await counts()
    // Network cap 2, domain cap 1: a campus of four.
    for (const name of ['a', 'b', 'c', 'd']) {
      expect((await signUpThroughApi(request, network, `${name}@${domain}`)).status).toBe(200)
    }
    const after = await counts()
    expect(after.wouldNetwork - before.wouldNetwork).toBe(2)
    expect(after.wouldDomain - before.wouldDomain).toBe(3)
    expect(after.refusedNetwork).toBe(before.refusedNetwork)
    expect(after.refusedDomain).toBe(before.refusedDomain)

    // Inbox cap 2 and the disposable list refuse while observing.
    const elsewhere = randomNetwork().address
    expect((await signUpThroughApi(request, elsewhere, `${RUN}obs@e2e.harmony.local`)).status).toBe(200)
    expect((await signUpThroughApi(request, elsewhere, `${RUN}obs+2@e2e.harmony.local`)).status).toBe(200)
    expect(await signUpThroughApi(request, elsewhere, `${RUN}obs+3@e2e.harmony.local`)).toEqual({ status: 422, msg: INBOX_TEXT })
    expect(await signUpThroughApi(request, elsewhere, `${RUN}o@mailinator.com`)).toEqual({ status: 422, msg: DOMAIN_TEXT })
  } finally {
    await setConfig('signup_enforce_caps', true)
    await setConfig('signup_daily_domain_cap', 0)
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const user of data?.users ?? []) {
      if (user.email?.endsWith(`@${domain}`)) await admin.auth.admin.deleteUser(user.id)
    }
  }
})

test('a campus, a company and a conference join at once; a throwaway mail service is refused', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const throwaway = `throwaway-${RUN}.example`

  // Enforcement off, as on a new instance: the daily caps only count.
  await setConfig('signup_enforce_caps', false)
  try {
    await test.step('a campus on one network and many department subdomains', async () => {
      const campus = randomNetwork().address
      for (let i = 0; i < 8; i++) {
        expect((await signUpThroughApi(request, campus, `${RUN}c${i}@dept${i}.campus-${RUN}.example`)).status).toBe(200)
      }
    })

    await test.step('a company at home, on many networks and one domain', async () => {
      for (let i = 0; i < 12; i++) {
        expect((await signUpThroughApi(request, randomNetwork().address, `${RUN}h${i}@studio-${RUN}.example`)).status).toBe(200)
      }
    })

    await test.step('a conference on one network and many domains', async () => {
      const conference = randomNetwork().address
      for (let i = 0; i < 8; i++) {
        expect((await signUpThroughApi(request, conference, `${RUN}k@company${i}-${RUN}.example`)).status).toBe(200)
      }
    })

    await test.step('a domain not yet looked up passes, and a lookup is owed', async () => {
      expect((await signUpThroughApi(request, randomNetwork().address, `${RUN}a@${throwaway}`)).status).toBe(200)
      const { data } = await admin.from('signup_mail_hosts').select('checked_at, due_at').eq('domain', throwaway).single()
      expect(data?.checked_at).toBeNull()
      expect(data?.due_at).not.toBeNull()
    })

    await test.step('once its mail host is known, the form refuses it from any network', async () => {
      await setMailHosts(throwaway, [`recv-${RUN}.erinn.biz`])
      const address = randomNetwork().address
      const form = await openRegister(browser, address)
      await expectRefused(form, address, `${RUN}b@${throwaway}`, DOMAIN_TEXT)
      await form.page.context().close()
    })

    await test.step('a shared mail service is not refused', async () => {
      const routed = `routed-${RUN}.example`
      await setMailHosts(routed, ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'])
      expect((await signUpThroughApi(request, randomNetwork().address, `${RUN}a@${routed}`)).status).toBe(200)
    })
  } finally {
    await setConfig('signup_enforce_caps', true)
  }
})

test('an admin changes the limits and the next sign-up follows them', async ({ request, page }) => {
  test.setTimeout(180_000)

  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  const card = page.locator('[data-testid="signup-limits"]')
  await expect(card).toBeVisible({ timeout: 30000 })

  await test.step('the stored values and the refusals show', async () => {
    await expect(card.locator('[data-testid="signup-limits-ip-cap"]')).toHaveValue('2')
    await expect(card.locator('[data-testid="signup-limits-enabled"]')).toBeChecked()
    await expect(card.locator('[data-testid="signup-limits-disposable"]')).toBeChecked()
    await expect(card.locator('[data-testid="signup-refusals-ip-cap"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-limits-domain-cap"]')).toHaveValue('0')
    await expect(card.locator('[data-testid="signup-refusals-domain-cap"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-limits-enforce"]')).toBeChecked()
    await expect(card.locator('[data-testid="signup-would-refuse-ip-cap"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-would-refuse-domain-cap"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-refusals-mailbox-cap"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-refusals-blocked-domain"]')).not.toHaveText('0')
    await expect(card.locator('[data-testid="signup-limits-mail-hosts"]')).toHaveValue('')
    await expect(card.locator('[data-testid="signup-refusals-mail-host"]')).not.toHaveText('0')
  })

  await test.step('bad values are refused where they were typed', async () => {
    await card.locator('[data-testid="signup-limits-ip-cap"]').fill('2000')
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(card.locator('[data-testid="signup-limits-error"]')).toHaveText('Enter a whole number from 0 to 1000.')
    await expect(card.locator('[data-testid="signup-limits-ip-cap"]')).toHaveAttribute('aria-invalid', 'true')

    await card.locator('[data-testid="signup-limits-ip-cap"]').fill('3')
    await card.locator('[data-testid="signup-limits-domains"]').fill('not a domain')
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(card.locator('[data-testid="signup-limits-error"]')).toHaveText('not is not a domain name.')
    expect(await readConfig('signup_daily_ip_cap')).toBe(2)
  })

  await test.step('a raised cap and a further domain are saved', async () => {
    await card.locator('[data-testid="signup-limits-domains"]').fill(`@${BLOCKED_DOMAIN.toUpperCase()}\n`)
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(card.locator('[data-testid="signup-limits-domains"]')).toHaveValue(BLOCKED_DOMAIN, { timeout: 15000 })
    await expect(card.locator('[data-testid="signup-limits-save"]')).toBeDisabled()
    expect(await readConfig('signup_daily_ip_cap')).toBe(3)
    expect(await readConfig('signup_blocked_email_domains')).toEqual([BLOCKED_DOMAIN])
    expect(await readConfig('signup_mailbox_cap')).toBe(2)
  })

  await test.step('the refused network gets its third account', async () => {
    expect((await signUpThroughApi(request, NETWORK_A.address, stranger('third'))).status).toBe(200)
    expect(await signUpThroughApi(request, NETWORK_A.address, stranger('fifth'))).toEqual({ status: 429, msg: NETWORK_TEXT })
  })

  await test.step('the further domain is refused', async () => {
    expect(await signUpThroughApi(request, NETWORK_C.address, `${RUN}@${BLOCKED_DOMAIN}`)).toEqual({ status: 422, msg: DOMAIN_TEXT })
  })

  await test.step('a mail host and a never-limited domain are saved and followed', async () => {
    const mailHost = `mailhost-${RUN}.example`
    const hosted = `hosted-${RUN}.example`
    const trusted = `trusted-${RUN}.example`
    const hosts = card.locator('[data-testid="signup-limits-mail-hosts"]')
    const never = card.locator('[data-testid="signup-limits-trusted"]')
    await setMailHosts(hosted, [`mx1.${mailHost}`])
    await setMailHosts(trusted, [`mx1.${mailHost}`])

    await hosts.fill('nodot')
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(card.locator('[data-testid="signup-limits-error"]')).toHaveText('nodot is not a domain name.')
    await expect(hosts).toHaveAttribute('aria-invalid', 'true')

    await hosts.fill(mailHost.toUpperCase())
    await never.fill('nodot')
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(card.locator('[data-testid="signup-limits-error"]')).toHaveText('nodot is not a domain name.')
    await expect(never).toHaveAttribute('aria-invalid', 'true')

    await never.fill(`@${trusted.toUpperCase()}\n`)
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect(never).toHaveValue(trusted, { timeout: 15000 })
    await expect(hosts).toHaveValue(mailHost)
    expect(await readConfig('signup_blocked_mail_hosts')).toEqual([mailHost])
    expect(await readConfig('signup_trusted_email_domains')).toEqual([trusted])

    expect(await signUpThroughApi(request, randomNetwork().address, `${RUN}a@${hosted}`)).toEqual({ status: 422, msg: DOMAIN_TEXT })
    expect((await signUpThroughApi(request, randomNetwork().address, `${RUN}a@${trusted}`)).status).toBe(200)
    expect((await signUpThroughApi(request, randomNetwork().address, `${RUN}b@${trusted}`)).status).toBe(200)

    // One list alone: a jsonb[] argument of only lists reads as a further dimension.
    await never.fill('')
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect.poll(() => readConfig('signup_trusted_email_domains'), { timeout: 15000 }).toEqual([])
    await expect(card.locator('[data-testid="signup-limits-error"]')).toHaveText('')
    expect(await readConfig('signup_blocked_mail_hosts')).toEqual([mailHost])
  })

  await test.step('with enforcement off, the full network signs up', async () => {
    await card.locator('[data-testid="signup-limits-enforce"]').uncheck()
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect.poll(() => readConfig('signup_enforce_caps'), { timeout: 15000 }).toBe(false)
    expect((await signUpThroughApi(request, NETWORK_A.address, stranger('sixth'))).status).toBe(200)
  })

  await test.step('turned off, nothing is refused', async () => {
    await card.locator('[data-testid="signup-limits-enabled"]').uncheck()
    await card.locator('[data-testid="signup-limits-save"]').click()
    await expect.poll(() => readConfig('signup_limits_enabled'), { timeout: 15000 }).toBe(false)
    expect((await signUpThroughApi(request, NETWORK_A.address, stranger('fifth'))).status).toBe(200)
  })
})
