// Journey: instance invitations from the admin panel (migration 20261105980001, federation-backend
// routes/adminInvites.ts).
//
// An instance admin creates a single-use link for an address on Admin > Invites; a new browser
// opens it, chooses a password on /reset-password?invite=1, lands signed in on profile creation,
// and signs in later with that password. The invitation moves from pending to accepted. A new
// link voids the one before, a revoked invitation's link fails and its unused account is gone;
// with SMTP set, Send by email has GoTrue email the invitation instead of showing a link;
// an address with an account is refused with nothing created. Members and moderators reach
// neither the page nor the routes. The page passes axe colour contrast with no skin in dark and
// light, Paper, Skyglass and high contrast, and at 375 px it has no horizontal scroll.
//
// Run with E2E_DISABLE_SIGNUP=true (e2e/stack.sh) the stack is an invite-only instance: GoTrue
// refuses sign-up and the whole journey runs against it. The first test records which mode ran.
// The stack's GoTrue reports its external URL without the gateway's /auth/v1 prefix; links are
// opened at /auth/v1/verify.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  signIn,
  userClient,
  type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'
import { expectNoAxeViolations } from './a11y'

// One worker runs the file in order; beforeAll seeds once.
test.describe.configure({ mode: 'default' })
test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const SUPABASE_URL = process.env.E2E_SUPABASE_URL || process.env.TEST_SUPABASE_URL || ''
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY || process.env.TEST_SUPABASE_ANON_KEY || ''
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const address = (name: string) => `${name}${tag}@e2e.harmony.local`
const NEW_PASSWORD = 'invited-password-12345'

let staff: SpecUser
let member: SpecUser
let moderator: SpecUser
let backend: Backend
let signupDisabled = false
const invitedEmails: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120_000)
  staff = await createUser(admin, 'invadm')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(`promote admin: ${error.message}`)
  member = await createUser(admin, 'invmem')
  moderator = await createUser(admin, 'invmod')
  await admin.from('profiles').update({ is_moderator: true }).eq('id', moderator.id)
  backend = await startBackend({ APP_URL: BASE_URL })

  const settings = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: ANON_KEY } })
  signupDisabled = (await settings.json()).disable_signup === true
})

test.afterAll(async () => {
  await backend?.stop()
  if (invitedEmails.length) {
    await admin.from('instance_invites').delete().in('email', invitedEmails)
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    for (const user of data?.users ?? []) {
      if (!invitedEmails.includes(user.email ?? '')) continue
      await admin.from('profiles').delete().eq('auth_user_id', user.id)
      await admin.auth.admin.deleteUser(user.id)
    }
  }
  for (const user of [staff, member, moderator]) await deleteUser(admin, user)
})

const verifyUrl = (link: string) => {
  const url = new URL(link)
  url.pathname = '/auth/v1/verify'
  return url.toString()
}

async function openInvites(page: Page) {
  await backend.route(page)
  await signIn(page, staff)
  await page.goto('/admin?tab=invites')
  await dismissAnnouncements(page)
  const panel = page.getByTestId('instance-invites')
  await expect(panel.getByTestId('invites-registration')).toBeVisible({ timeout: 30000 })
  return panel
}

async function createInvite(page: Page, email: string) {
  const panel = page.getByTestId('instance-invites')
  invitedEmails.push(email)
  await panel.getByLabel('Email address').fill(email)
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/federation/admin/invites') && r.request().method() === 'POST'),
    panel.getByRole('button', { name: 'Create invitation' }).click(),
  ])
  expect(response.status()).toBe(201)
  const body = await response.json()
  await expect(panel.getByTestId('invite-link')).toHaveValue(body.link)
  return body as { link: string; expires_at: string; invite: { id: string; auth_user_id: string } }
}

async function openLink(browser: Browser, link: string) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto(verifyUrl(link))
  return { context, page }
}

// A routed page's requests still in flight fail the test when its context closes under them.
async function closeRouted(context: BrowserContext, page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await context.close()
}

async function tokenOf(user: SpecUser): Promise<string> {
  const client = await userClient(user)
  const { data } = await client.auth.getSession()
  return data.session!.access_token
}

test('an admin invites by link; the person chooses a password and lands signed in', async ({ page, browser, context }) => {
  test.setTimeout(240_000)
  test.info().annotations.push({ type: 'sign-up', description: signupDisabled ? 'disabled (invite-only instance)' : 'enabled' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
  const email = address('ada')
  const username = `ada${tag}`.replace(/[^a-z0-9]/g, '')

  if (signupDisabled) {
    await test.step('the instance refuses sign-up', async () => {
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
      const { error } = await anon.auth.signUp({ email: address('nosignup'), password: NEW_PASSWORD })
      expect(error?.code).toBe('signup_disabled')
    })
  }

  const panel = await openInvites(page)
  let issued: Awaited<ReturnType<typeof createInvite>>

  await test.step('the page states the registration mode and that email cannot be sent', async () => {
    await expect(panel.getByTestId('invites-registration'))
      .toContainText(signupDisabled ? 'Registration: invite only.' : 'Registration: open.')
    await expect(panel.getByText('Invitations work in every registration mode')).toBeVisible()
    await expect(panel.getByLabel('Send by email')).toBeDisabled()
    await expect(panel.getByTestId('invite-send-hint')).toContainText('This instance cannot send email')
  })

  await test.step('a malformed address is refused in place', async () => {
    await panel.getByLabel('Email address').fill('not an address')
    await panel.getByRole('button', { name: 'Create invitation' }).click()
    await expect(panel.getByTestId('invite-error')).toHaveText('Enter an email address, like name@example.org.')
    await expect(panel.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true')
  })

  await test.step('the admin creates a link; it expires when GoTrue says', async () => {
    issued = await createInvite(page, email)
    expect(issued.link).toContain('type=invite')
    const { data } = await admin.auth.admin.getUserById(issued.invite.auth_user_id)
    const sentAt = Date.parse(data.user!.confirmation_sent_at!)
    expect(Date.parse(issued.expires_at) - sentAt).toBe(86400 * 1000)
    await expect(panel.getByTestId('invite-result')).toContainText(`Invitation for ${email}.`)

    await panel.getByTestId('invite-copy').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issued.link)
  })

  await test.step('it is listed as pending, by this admin, as a link, with its expiry', async () => {
    const row = panel.getByTestId(`invite-${email}`)
    await expect(row).toBeVisible()
    await expect(row).toContainText(`@${staff.username}`)
    await expect(row).toContainText('Link')
    await expect(row.getByTestId('invite-expiry')).toContainText('Expires')
    const { data: log } = await admin.from('admin_audit_log').select('action_type, admin_id')
      .eq('target_id', issued.invite.id)
    expect(log).toEqual([{ action_type: 'instance_invite_created', admin_id: staff.id }])
  })

  await test.step('a new browser opens the link, chooses a password and lands signed in', async () => {
    const guest = await openLink(browser, issued.link)
    const p = guest.page
    await expect(p.getByRole('heading', { level: 2, name: 'Welcome! Choose a password' })).toBeVisible({ timeout: 30000 })
    await expect(p.getByTestId('reset-subtitle')).toContainText(email)
    await p.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await p.getByLabel('Confirm new password', { exact: true }).fill(NEW_PASSWORD)
    await p.getByRole('button', { name: 'Set password and continue' }).click()

    await expect(p).toHaveURL(/new-profile/, { timeout: 30000 })
    await expect(p.locator('[data-testid="new-profile-card"]')).toBeVisible({ timeout: 15000 })
    await expect(p.getByText(`Signed in as ${email}.`)).toBeVisible()
    await p.locator('[data-testid="profile-display-name"]').fill('Ada Invited')
    await p.locator('[data-testid="profile-username"]').fill(username)
    await expect(p.locator('[data-testid="username-available"]')).toBeVisible({ timeout: 15000 })
    await p.locator('[data-testid="profile-submit"]').click()
    await expect(p).toHaveURL(/\/chat/, { timeout: 60000 })
    await guest.context.close()
  })

  await test.step('the chosen password signs in on another browser', async () => {
    const later = await browser.newContext({ serviceWorkers: 'block' })
    const p = await later.newPage()
    await signIn(p, { id: '', email, username, displayName: username, password: NEW_PASSWORD })
    await later.close()
  })

  await test.step('the invitation moves from pending to accepted', async () => {
    await panel.getByRole('button', { name: 'Refresh' }).click()
    await expect(panel.getByTestId(`invite-${email}`)).toHaveCount(0)
    await expect(panel.getByTestId(`invite-closed-${email}`).getByTestId('invite-outcome'))
      .toContainText(`Joined as @${username}`)
  })

  await test.step('the route refuses to revoke the account that signed in', async () => {
    const res = await fetch(`${backend.url}/admin/invites/${issued.invite.auth_user_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await tokenOf(staff)}` },
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('invite_accepted')
    const { data } = await admin.auth.admin.getUserById(issued.invite.auth_user_id)
    expect(data.user?.email).toBe(email)
  })
})

test('a new link voids the one before; a revoked link fails and its account is gone', async ({ page, browser, context }) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
  const email = address('bea')
  const panel = await openInvites(page)
  const first = await createInvite(page, email)
  const row = panel.getByTestId(`invite-${email}`)

  let second = ''
  await test.step('Copy new link makes and copies another link', async () => {
    await row.getByRole('button', { name: `Copy new link for ${email}` }).click()
    await expect(panel.getByTestId('invite-result')).toContainText(`New link for ${email}`)
    second = await panel.getByTestId('invite-link').inputValue()
    expect(second).not.toBe(first.link)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second)
    await expect(row).toContainText('2 links made')
  })

  await test.step('the first link no longer works', async () => {
    const guest = await openLink(browser, first.link)
    await expect(guest.page.getByRole('heading', { level: 2, name: 'This invitation link does not work' }))
      .toBeVisible({ timeout: 30000 })
    await guest.context.close()
  })

  await test.step('revoking asks first, then lists it as revoked', async () => {
    await row.getByRole('button', { name: `Revoke the invitation for ${email}` }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(`The link for ${email} stops working`)
    await dialog.getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveCount(0, { timeout: 15000 })
    await expect(panel.getByTestId(`invite-closed-${email}`).getByTestId('invite-outcome'))
      .toContainText(`Revoked by @${staff.username}`)
  })

  await test.step('the second link fails and the unused account is gone', async () => {
    const guest = await openLink(browser, second)
    await expect(guest.page.getByRole('heading', { level: 2, name: 'This invitation link does not work' }))
      .toBeVisible({ timeout: 30000 })
    await expect(guest.page.locator('p.form-subtitle')).toContainText('Ask the person who invited you for a new one.')
    await guest.context.close()
    const { data } = await admin.auth.admin.getUserById(first.invite.auth_user_id)
    expect(data.user).toBeNull()
    const { data: log } = await admin.from('admin_audit_log').select('action_type')
      .eq('target_id', first.invite.id).order('created_at')
    expect(log?.map((r) => r.action_type)).toEqual(['instance_invite_created', 'instance_invite_reissued', 'instance_invite_revoked'])
  })
})

test('with SMTP set, Send by email has the sign-in service email the invitation', async ({ page }) => {
  test.setTimeout(150_000)
  // The stack's GoTrue has no SMTP host and takes every send without sending (its noop mailer):
  // this covers the page and the backend's /invite call, not delivery.
  const mailing = await startBackend({ APP_URL: BASE_URL, GOTRUE_SMTP_HOST: 'smtp.e2e.test' })
  try {
    await mailing.route(page)
    await signIn(page, staff)
    await page.goto('/admin?tab=invites')
    await dismissAnnouncements(page)
    const panel = page.getByTestId('instance-invites')
    const send = panel.getByLabel('Send by email')
    await expect(send).toBeEnabled({ timeout: 30000 })
    await expect(panel.getByTestId('invite-send-hint')).toContainText('The auth service emails the link')

    const email = address('eve')
    invitedEmails.push(email)
    await panel.getByLabel('Email address').fill(email)
    await send.check()
    await panel.getByRole('button', { name: 'Create invitation' }).click()
    await expect(panel.getByTestId('invite-result')).toContainText(`Invitation emailed to ${email}.`)
    await expect(panel.getByTestId('invite-link')).toHaveCount(0)
    await expect(panel.getByTestId(`invite-${email}`)).toContainText('Email')

    const { data } = await admin.from('instance_invites').select('delivery, auth_user_id').eq('email', email).single()
    expect(data?.delivery).toBe('email')
    const { data: user } = await admin.auth.admin.getUserById(data!.auth_user_id)
    expect(user.user?.invited_at).toBeTruthy()
    expect(user.user?.email_confirmed_at ?? null).toBeNull()
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await mailing.stop()
  }
})

test('an address with an account is refused and nothing is created', async ({ page }) => {
  test.setTimeout(120_000)
  const panel = await openInvites(page)
  const { count: before } = await admin.from('instance_invites').select('id', { count: 'exact', head: true })
  await panel.getByLabel('Email address').fill(member.email.toUpperCase())
  await panel.getByRole('button', { name: 'Create invitation' }).click()
  await expect(panel.getByTestId('invite-error'))
    .toHaveText('An account with this address already exists. Nothing was created.')
  await expect(panel.getByTestId('invite-result')).toHaveCount(0)
  const { count: after } = await admin.from('instance_invites').select('id', { count: 'exact', head: true })
  expect(after).toBe(before)
  const { data } = await admin.from('profiles').select('id').eq('auth_user_id', member.id)
  expect(data).toHaveLength(1)
})

test('members and moderators reach neither the page nor the routes', async ({ page, browser }) => {
  test.setTimeout(120_000)

  await test.step('the routes answer 401 without a token and 403 to a member or a moderator', async () => {
    const anon = await fetch(`${backend.url}/admin/invites`)
    expect(anon.status).toBe(401)
    for (const user of [member, moderator]) {
      const token = await tokenOf(user)
      const list = await fetch(`${backend.url}/admin/invites`, { headers: { Authorization: `Bearer ${token}` } })
      expect([list.status, (await list.json()).error]).toEqual([403, 'admin_required'])
      const create = await fetch(`${backend.url}/admin/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address('sneaky') }),
      })
      expect(create.status).toBe(403)
    }
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
    expect(data.users.some((u) => u.email === address('sneaky'))).toBe(false)
  })

  await test.step('a member is sent away from the admin panel', async () => {
    await backend.route(page)
    await signIn(page, member)
    await page.goto('/admin?tab=invites')
    await expect(page).toHaveURL(/\/chat/, { timeout: 30000 })
    await expect(page.getByTestId('instance-invites')).toHaveCount(0)
  })

  await test.step('a moderator sees the panel without the Invites tab', async () => {
    const mod = await browser.newContext({ serviceWorkers: 'block' })
    const p = await mod.newPage()
    await backend.route(p)
    await signIn(p, moderator)
    await p.goto('/admin?tab=invites')
    await expect(p.locator('.admin-panel')).toBeVisible({ timeout: 30000 })
    await expect(p.getByRole('tab', { name: 'Reports' })).toBeVisible()
    await expect(p.getByRole('tab', { name: 'Invites' })).toHaveCount(0)
    await expect(p.getByTestId('instance-invites')).toHaveCount(0)
    await closeRouted(mod, p)
  })
})

const APPEARANCES = [
  { skin: null, theme: 'dark', highContrast: false },
  { skin: null, theme: 'light', highContrast: false },
  { skin: 'paper', theme: 'light', highContrast: false },
  { skin: 'skyglass', theme: 'dark', highContrast: false },
  { skin: null, theme: 'dark', highContrast: true },
] as const

test('the Invites page reads in each skin and theme', async ({ browser }) => {
  test.setTimeout(240_000)
  const email = address('dee')
  invitedEmails.push(email)
  const created = await fetch(`${backend.url}/admin/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenOf(staff)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  expect(created.status).toBe(201)

  for (const { skin, theme, highContrast } of APPEARANCES) {
    const label = `${skin ?? 'no skin'} ${theme}${highContrast ? ' high contrast' : ''}`
    await test.step(label, async () => {
      const { error } = await admin.from('profiles')
        .update({ appearance_settings: { theme, activeSkinId: skin, highContrast } }).eq('id', staff.id)
      if (error) throw new Error(`appearance: ${error.message}`)
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      const panel = await openInvites(page)
      await expect(panel.getByTestId(`invite-${email}`)).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme-type', theme, { timeout: 15000 })
      if (skin) await expect(page.locator('html')).toHaveAttribute('data-skin', skin, { timeout: 15000 })
      if (highContrast) await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(600)
      await expectNoAxeViolations(page, { include: '[data-testid="instance-invites"]', rules: ['color-contrast'], label })
      await closeRouted(context, page)
    })
  }
  await admin.from('profiles').update({ appearance_settings: null }).eq('id', staff.id)
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('the Invites page fits 375 px and passes axe', async ({ page }) => {
    test.setTimeout(120_000)
    const panel = await openInvites(page)
    await createInvite(page, address('cy'))
    const row = panel.getByTestId(`invite-${address('cy')}`)
    await expect(row).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const button of [row.getByTestId('invite-reissue'), row.getByTestId('invite-revoke')]) {
      const box = (await button.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(375)
    }
    await expectNoAxeViolations(page, { include: '[data-testid="instance-invites"]' })
  })
})
