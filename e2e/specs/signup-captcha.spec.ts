// Journey: the sign-up check (20261111100001). The hook answers 428 for a sign-up that looks
// automated; the form shows the widget from public/embed-player.html?captcha=…, and the widget's
// token resubmits the form as user_metadata.captcha_token, which the database verifies.
//
// Offline by default: Turnstile's api.js is replaced by a stand-in that renders a button and hands
// out the tokens a test names (site key e2e-unlisted-host reports Turnstile's 110200 instead), and
// public.signup_captcha_check, which the hook and the admin test both call, by a stub that passes
// 'e2e-pass-token' alone. E2E_LIVE_CAPTCHA=1 loads Cloudflare's own widget with its test site key
// 1x00000000000000000000AA and verifies with its test secret through siteverify; the refused-token
// test and the hostname step need the stand-in and are skipped then.
//
// The stack's GoTrue runs the hook and reads Sb-Forwarded-For from X-E2E-Client-IP
// (e2e/gateway.conf). Addresses are random /56s of 2001:db8::/32. instance_config signup_* keys and
// the verify function are restored after; specs that sign up from public addresses
// (signup-limits*, signup-review) must not run alongside, as in CI (workers: 1).

import { execFileSync } from 'node:child_process'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, loadApp, signIn, PASSWORD, type SpecUser } from './harness'

const LIVE = process.env.E2E_LIVE_CAPTCHA === '1'
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const SITE_KEY = LIVE ? '1x00000000000000000000AA' : '0x4AAAAAAAE2Ee2eE2e'
const SECRET = LIVE ? '1x0000000000000000000000000000000AA' : 'e2e-secret'
const ASKED_TEXT = 'Complete the check to finish signing up.'
const REFUSED_TEXT = 'The check did not pass. Try it again.'

const admin = adminClient()
let staff: SpecUser
let snapshot: Array<{ config_key: string; config_value: unknown; description: string | null }> = []
let savedCheck = ''

function randomNetwork(): string {
  const group = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16)
  return `2001:db8:${group()}:${(1 + Math.floor(Math.random() * 0xfe)).toString(16)}00::1`
}

function sql(query: string): string {
  const project = process.env.E2E_PROJECT || 'hme2e'
  const cid = execFileSync('docker', ['ps', '-q',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=db']).toString().trim()
  if (!cid) throw new Error(`no db container for project ${project}`)
  return execFileSync('docker', ['exec', '-i', cid, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-tAc', query]).toString().trim()
}

async function setConfig(key: string, value: unknown): Promise<void> {
  const { error } = await admin.from('instance_config').update({ config_value: value }).eq('config_key', key)
  if (error) throw new Error(`${key}: ${error.message}`)
}

async function readConfig(key: string): Promise<unknown> {
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', key).maybeSingle()
  return data?.config_value
}

async function counts(): Promise<{ asked: number; passed: number; failed: number }> {
  const { data } = await admin.from('signup_captcha_counts').select('asked, passed, failed')
  return (data ?? []).reduce(
    (t, r) => ({ asked: t.asked + r.asked, passed: t.passed + r.passed, failed: t.failed + r.failed }),
    { asked: 0, passed: 0, failed: 0 },
  )
}

async function accountMetadata(email: string): Promise<Record<string, unknown> | null> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const user = (data?.users ?? []).find((u) => u.email === email)
  return user ? (user.user_metadata as Record<string, unknown>) : null
}

/** Turnstile's api.js stand-in: a button whose clicks hand out `tokens` in turn. */
async function standInWidget(context: BrowserContext, tokens: string[]): Promise<void> {
  if (LIVE) return
  const script = `(function () {
    var tokens = ${JSON.stringify(tokens)};
    var clicks = 0;
    window.turnstile = {
      render: function (el, o) {
        if (o.sitekey === 'e2e-unlisted-host') {
          setTimeout(function () { o['error-callback']('110200'); }, 0);
          return 'w1';
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Verify you are human';
        b.setAttribute('data-testid', 'stand-in-widget');
        b.onclick = function () { o.callback(tokens[Math.min(clicks++, tokens.length - 1)]); };
        el.appendChild(b);
        return 'w1';
      },
      reset: function () {}
    };
    var cb = new URL(document.currentScript.src).searchParams.get('onload');
    if (cb && typeof window[cb] === 'function') window[cb]();
  })();`
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: script }))
}

interface RegisterForm {
  page: Page
  bodies: Array<Record<string, any>>
}

async function openRegister(browser: Browser, address: string, tokens: string[]): Promise<RegisterForm> {
  const context = await browser.newContext()
  await standInWidget(context, tokens)
  const page = await context.newPage()
  const form: RegisterForm = { page, bodies: [] }
  await page.route('**/auth/v1/signup**', async (route) => {
    form.bodies.push(route.request().postDataJSON() ?? {})
    await route.continue({ headers: { ...route.request().headers(), 'x-e2e-client-ip': address } })
  })
  await loadApp(page, '/register', page.locator('[data-testid="auth-email"]'))
  return form
}

async function fillAndSubmit(page: Page, email: string): Promise<number> {
  await page.locator('[data-testid="auth-email"]').fill(email)
  await page.locator('[data-testid="auth-password"]').fill(PASSWORD)
  const answered = page.waitForResponse((r) => r.url().includes('/auth/v1/signup') && r.request().method() === 'POST', {
    timeout: 30000,
  })
  await page.locator('[data-testid="auth-submit"]').click()
  return (await answered).status()
}

/** Answers the widget: the stand-in's button, or Cloudflare's test widget, which passes by itself. */
async function answerWidget(page: Page): Promise<void> {
  const frame = page.frameLocator('[data-testid="signup-captcha-frame"]')
  if (!LIVE) await frame.locator('[data-testid="stand-in-widget"]').click()
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
  await setConfig('signup_daily_ip_cap', 0)
  await setConfig('signup_daily_domain_cap', 0)
  await setConfig('signup_mailbox_cap', 0)
  await setConfig('signup_enforce_caps', false)
  await setConfig('signup_captcha_provider', 'turnstile')
  await setConfig('signup_captcha_site_key', SITE_KEY)
  await setConfig('signup_captcha_secret', SECRET)
  await setConfig('signup_captcha_mode', 'suspect')

  if (!LIVE) {
    savedCheck = sql("SELECT pg_get_functiondef('public.signup_captcha_check(text,text,text,text)'::regprocedure)")
    sql(`CREATE OR REPLACE FUNCTION public.signup_captcha_check(p_provider text, p_secret text, p_token text, p_remote_ip text)
         RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
         AS $$ SELECT CASE WHEN p_token = 'e2e-pass-token'
                           THEN '{"verdict":"pass","codes":[],"detail":"answer","http_status":200}'::jsonb
                           ELSE '{"verdict":"fail","codes":["invalid-input-response"],"detail":"answer","http_status":200}'::jsonb END $$`)
  }

  staff = await createUser(admin, 'sigcheck')
  const { error: promoteError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (promoteError) throw new Error(promoteError.message)
})

test.afterAll(async () => {
  if (savedCheck) sql(savedCheck)
  if (snapshot.length) await admin.from('instance_config').upsert(snapshot, { onConflict: 'config_key' })
  if (staff) await deleteUser(admin, staff)
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  for (const user of data?.users ?? []) {
    if (user.email?.startsWith(RUN)) await admin.auth.admin.deleteUser(user.id)
  }
})

test('a sign-up on a new email domain is asked for the check, and its token creates the account', async ({ browser }) => {
  test.setTimeout(120_000)
  const email = `${RUN}a@new-${RUN}.example`
  const before = await counts()
  const form = await openRegister(browser, randomNetwork(), ['e2e-pass-token'])

  await test.step('the hook asks; the form shows the widget, not an error', async () => {
    expect(await fillAndSubmit(form.page, email)).toBe(428)
    await expect(form.page.locator('[data-testid="signup-captcha"]')).toContainText(ASKED_TEXT)
    await expect(form.page.locator('[data-testid="auth-form-error"]')).toHaveText('')
    expect(form.bodies[0]?.data?.captcha_token).toBeUndefined()
  })

  await test.step('the widget runs on this page\'s origin', async () => {
    const src = await form.page.locator('[data-testid="signup-captcha-frame"]').getAttribute('src')
    const url = new URL(src ?? '', form.page.url())
    expect(url.origin).toBe(new URL(form.page.url()).origin)
    expect(url.pathname).toBe('/embed-player.html')
    expect(url.searchParams.get('captcha')).toBe('turnstile')
    expect(url.searchParams.get('sitekey')).toBe(SITE_KEY)
  })

  await test.step('answering it signs up without a second click', async () => {
    const resent = form.page.waitForResponse((r) => r.url().includes('/auth/v1/signup') && r.request().method() === 'POST', {
      timeout: 30000,
    })
    await answerWidget(form.page)
    expect((await resent).status()).toBe(200)
    await expect(form.page).toHaveURL(/new-profile/, { timeout: 30000 })
    expect(form.bodies.at(-1)?.data?.captcha_token).toBe(LIVE ? 'XXXX.DUMMY.TOKEN.XXXX' : 'e2e-pass-token')
  })

  await test.step('the account keeps no token, and the counts show one ask and one pass', async () => {
    const metadata = await accountMetadata(email)
    expect(metadata).not.toBeNull()
    expect(metadata).not.toHaveProperty('captcha_token')
    const after = await counts()
    expect(after.asked - before.asked).toBe(1)
    expect(after.passed - before.passed).toBe(1)
  })
  await form.page.context().close()
})

test('a refused token resets the widget, and the next answer passes', async ({ browser }) => {
  test.skip(LIVE, 'needs the stand-in widget')
  test.setTimeout(120_000)
  const email = `${RUN}b@new-${RUN}-b.example`
  const before = await counts()
  const form = await openRegister(browser, randomNetwork(), ['e2e-bad-token', 'e2e-pass-token'])

  expect(await fillAndSubmit(form.page, email)).toBe(428)
  const refused = form.page.waitForResponse((r) => r.url().includes('/auth/v1/signup') && r.request().method() === 'POST')
  await answerWidget(form.page)
  expect((await refused).status()).toBe(428)
  await expect(form.page.locator('[data-testid="signup-captcha"]')).toContainText(REFUSED_TEXT)
  await expect(form.page).toHaveURL(/register/)

  const passed = form.page.waitForResponse((r) => r.url().includes('/auth/v1/signup') && r.request().method() === 'POST')
  await answerWidget(form.page)
  expect((await passed).status()).toBe(200)
  await expect(form.page).toHaveURL(/new-profile/, { timeout: 30000 })
  const after = await counts()
  expect(after.failed - before.failed).toBe(1)
  expect(after.passed - before.passed).toBe(1)
  await form.page.context().close()
})

test('an ordinary sign-up is not asked', async ({ browser }) => {
  test.setTimeout(90_000)
  const domain = `known-${RUN}.example`
  const { error } = await admin
    .from('signup_mail_hosts')
    .upsert({ domain, hosts: [`mx.${domain}`], checked_at: new Date().toISOString(), due_at: null }, { onConflict: 'domain' })
  if (error) throw new Error(error.message)
  const form = await openRegister(browser, randomNetwork(), ['e2e-pass-token'])
  expect(await fillAndSubmit(form.page, `${RUN}c@${domain}`)).toBe(200)
  await expect(form.page).toHaveURL(/new-profile/, { timeout: 30000 })
  expect(form.bodies).toHaveLength(1)
  await form.page.context().close()
})

test('an admin tests new keys before saving them; the secret is written, never shown', async ({ page }) => {
  test.setTimeout(120_000)
  const NEXT_SITE = LIVE ? '1x00000000000000000000AA' : '0x4AAAAAAAE2Enext'
  const NEXT_SECRET = LIVE ? '1x0000000000000000000000000000000AA' : 'e2e-secret-next'
  await standInWidget(page.context(), ['e2e-pass-token'])
  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  const card = page.locator('[data-testid="signup-captcha-settings"]')
  const field = (id: string) => card.locator(`[data-testid="signup-captcha-${id}"]`)
  await expect(card).toBeVisible({ timeout: 30000 })

  await test.step('the stored settings load; the secret only as saved', async () => {
    await expect(field('provider')).toHaveValue('turnstile')
    await expect(field('site-key')).toHaveValue(SITE_KEY)
    await expect(field('secret')).toHaveValue('')
    await expect(field('secret')).toHaveAttribute('placeholder', /Saved/)
    await expect(field('counts')).toBeVisible()
    expect(await card.innerHTML()).not.toContain(SECRET)
  })

  // Needs the stand-in widget.
  if (!LIVE) await test.step('a site key whose widget lacks this hostname names the fix, and does not save', async () => {
    await field('site-key').fill('e2e-unlisted-host')
    await field('secret').fill(NEXT_SECRET)
    await field('test').click()
    await expect(field('test-result')).toContainText(new URL(page.url()).hostname)
    await expect(field('test-result')).toContainText('110200')
    await field('save').click()
    await expect(field('error')).toHaveText('Test the keys before saving.')
    expect(await readConfig('signup_captcha_site_key')).toBe(SITE_KEY)
  })

  await test.step('new keys save after a passing test', async () => {
    await field('site-key').fill(NEXT_SITE)
    await field('secret').fill(NEXT_SECRET)
    await field('mode-always').check()
    await field('save').click()
    await expect(field('error')).toHaveText('Test the keys before saving.')
    await field('test').click()
    if (!LIVE) await card.frameLocator('[data-testid="signup-captcha-frame"]').locator('[data-testid="stand-in-widget"]').click()
    await expect(field('test-result')).toHaveText('The keys work: the server verified the token with the provider.', { timeout: 30000 })
    await field('save').click()
    // Live, the next keys equal the first: the mode is the value that changes.
    await expect.poll(() => readConfig('signup_captcha_mode'), { timeout: 15000 }).toBe('always')
    expect(await readConfig('signup_captcha_site_key')).toBe(NEXT_SITE)
    expect(await readConfig('signup_captcha_secret')).toBe(NEXT_SECRET)
    await expect(field('secret')).toHaveValue('')
  })

  // A write of the stored value logs nothing; live, the next secret is the first one.
  if (NEXT_SECRET !== SECRET) await test.step('the audit log records that a secret was set, not its value', async () => {
    const rows = sql(`SELECT action_details::text FROM public.admin_audit_log
                       WHERE action_type = 'config_change' AND action_details ->> 'key' = 'signup_captcha_secret'
                       ORDER BY created_at DESC LIMIT 1`)
    expect(JSON.parse(rows)).toMatchObject({ key: 'signup_captcha_secret', old_value: 'set', new_value: 'set' })
    expect(rows).not.toContain(NEXT_SECRET)
  })

  await test.step('after a reload the secret is still not on the page', async () => {
    await page.reload()
    await expect(field('site-key')).toHaveValue(NEXT_SITE, { timeout: 30000 })
    await expect(field('secret')).toHaveValue('')
    expect(await card.innerHTML()).not.toContain(NEXT_SECRET)
  })
})

