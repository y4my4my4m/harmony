// Journey: turning two-factor off in Settings > Security with a recovery code.
//
// The settings page signs in through the TOTP challenge, so its session is aal2. A wrong
// code changes nothing. The right code removes the factor and leaves no usable code, and a
// password alone signs in afterwards. A connection lost after the first request that changes
// two-factor state reaches the server never leaves a spent code with two-factor still on.
//
// Factors are read through GoTrue's admin API. Recovery codes have no service_role grant;
// counts come from get_mfa_recovery_status() through the enrolment session, which is aal2.

import { test, expect, type Page, type Request } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { adminClient, createUser, deleteUser, dismissAnnouncements, loadApp, userClient, type SpecUser } from './harness'
import { enrolTotp, nextUnusedStep, totp, type TotpUser } from './totp'

// In order on one worker: the two sign-ins would otherwise wait for the same TOTP step and
// challenge GoTrue at once (see enrolTotp).
test.describe.configure({ mode: 'default' })

const admin = adminClient()
const users: SpecUser[] = []

// Crockford base32 never issues U; this one matches no generated code.
const WRONG_CODE = 'UUUUU-UUUUU'

interface Enrolled extends TotpUser {
  user: SpecUser
  codes: string[]
}

test.afterAll(async () => {
  for (const user of users) await deleteUser(admin, user)
})

async function enrolledUser(tag: string): Promise<Enrolled> {
  const user = await createUser(admin, tag)
  users.push(user)
  const enrolled = await enrolTotp(user)
  const { data: codes, error } = await enrolled.client.rpc('generate_mfa_recovery_codes')
  if (error || !Array.isArray(codes) || codes.length !== 10) throw new Error(`recovery codes: ${error?.message}`)
  return { ...enrolled, user, codes: codes as string[] }
}

async function verifiedFactors(user: SpecUser): Promise<string[]> {
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: user.id })
  if (error) throw new Error(`list factors: ${error.message}`)
  return (data?.factors ?? []).filter((f) => f.status === 'verified').map((f) => f.id)
}

interface RecoveryStatus { mfa_enabled: boolean; total: number; remaining: number }

async function recoveryStatus(client: SupabaseClient): Promise<RecoveryStatus> {
  const { data, error } = await client.rpc('get_mfa_recovery_status')
  if (error) throw new Error(`recovery status: ${error.message}`)
  return data as RecoveryStatus
}

/** Password, then the authenticator code from a step not yet used. */
async function signInWithTotp(page: Page, account: Enrolled): Promise<void> {
  await loadApp(page, '/login', page.getByTestId('auth-email'))
  await page.getByTestId('auth-email').fill(account.user.email)
  await page.getByTestId('auth-password').fill(account.user.password)
  await page.getByTestId('auth-password').press('Enter')
  const code = page.getByRole('dialog', { name: 'Two-factor authentication' })
    .getByRole('textbox', { name: 'Verification code' })
  await expect(code).toBeFocused({ timeout: 30000 })
  const step = await nextUnusedStep(page, account.usedStep)
  await page.keyboard.type(totp(account.secret, step))
  await page.waitForURL(/\/chat/, { timeout: 30000 })
  account.usedStep = step
  await dismissAnnouncements(page)
}

const twoFactor = (page: Page) => page.getByRole('region', { name: 'Two-factor authentication' })
const disableDialog = (page: Page) => page.getByRole('dialog', { name: 'Turn off two-factor authentication?' })

async function openTwoFactor(page: Page) {
  await page.goto('/settings/security')
  await expect(twoFactor(page).getByText('On', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(twoFactor(page).getByText('10 of 10 unused')).toBeVisible()
}

async function submitRecoveryCode(page: Page, code: string) {
  const dialog = disableDialog(page)
  if (!(await dialog.isVisible())) {
    await twoFactor(page).getByRole('button', { name: 'Turn off', exact: true }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Lost your authenticator? Use a recovery code' }).click()
  }
  const field = dialog.getByRole('textbox', { name: 'Recovery code' })
  await field.fill(code)
  await dialog.getByRole('button', { name: 'Turn off', exact: true }).click()
}

/** Factor ids on the user of the session the app stored (auth-js `<storageKey>` entry). */
async function storedSessionFactors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (!key?.endsWith('-auth-token')) continue
        const session = JSON.parse(store.getItem(key) ?? 'null') as { user?: { factors?: { id: string }[] } } | null
        return (session?.user?.factors ?? []).map((f) => f.id)
      }
    }
    throw new Error('no stored session')
  })
}

function tokenAal(request: Request): string | undefined {
  const token = request.headers().authorization?.replace(/^Bearer /, '')
  if (!token) return undefined
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).aal
}

/** Requests that change two-factor state: either recovery RPC, or GoTrue's factor delete. */
function changesTwoFactor(request: Request): boolean {
  const { pathname } = new URL(request.url())
  return pathname.endsWith('/rpc/redeem_recovery_code_and_disable_mfa')
    || pathname.endsWith('/rpc/verify_recovery_code')
    || (request.method() === 'DELETE' && /\/auth\/v1\/factors\//.test(pathname))
}

test('a wrong recovery code changes nothing; the right one turns two-factor off for good', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await enrolledUser('twofarec')
  await signInWithTotp(page, account)
  await openTwoFactor(page)

  const aals: (string | undefined)[] = []
  page.on('request', (request) => { if (changesTwoFactor(request)) aals.push(tokenAal(request)) })

  expect(await storedSessionFactors(page)).toEqual([account.factorId])

  await test.step('a wrong code is refused and leaves the factor and every code', async () => {
    await submitRecoveryCode(page, WRONG_CODE)
    const error = disableDialog(page).getByRole('alert')
    await expect(error).not.toHaveText('', { timeout: 15000 })
    await expect(disableDialog(page)).toBeVisible()
    expect(await verifiedFactors(account.user)).toEqual([account.factorId])
    expect(await recoveryStatus(account.client)).toMatchObject({ mfa_enabled: true, total: 10, remaining: 10 })
  })

  await test.step('the right code turns two-factor off', async () => {
    await submitRecoveryCode(page, account.codes[3])
    await expect(page.getByText('Two-factor authentication is off')).toBeVisible({ timeout: 15000 })
    await expect(disableDialog(page)).toBeHidden()
    await expect(twoFactor(page).getByText('Off', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Set up two-factor authentication' })).toBeFocused()
    expect(aals.length).toBeGreaterThan(0)
    expect(aals.every((aal) => aal === 'aal2')).toBe(true)
  })

  await test.step("the app's stored session no longer lists the factor", async () => {
    expect(await storedSessionFactors(page)).toEqual([])
  })

  await test.step('no factor remains and no code is left', async () => {
    const { data } = await admin.auth.admin.mfa.listFactors({ userId: account.user.id })
    expect(data?.factors ?? []).toEqual([])
    expect(await recoveryStatus(account.client)).toMatchObject({ mfa_enabled: false, total: 0, remaining: 0 })
  })

  await test.step('one security notice says a recovery code turned two-factor off', async () => {
    const { data, error } = await admin.from('notifications')
      .select('data').eq('user_id', account.user.id).eq('type', 'security')
    expect(error).toBeNull()
    const events = (data ?? []).map((n) => n.data as { event: string; reason?: string })
      .filter((d) => d.event === 'mfa_disabled' || d.event === 'recovery_code_used')
    expect(events).toEqual([expect.objectContaining({ event: 'mfa_disabled', reason: 'recovery_code' })])
  })

  await test.step('the spent code works nowhere again; a password alone signs in', async () => {
    const passwordOnly = await userClient(account.user)
    const redeem = await passwordOnly.rpc('redeem_recovery_code_and_disable_mfa', { p_code: account.codes[3] })
    expect(redeem.error).toBeNull()
    expect(redeem.data).toBe(false)
    const verify = await passwordOnly.rpc('verify_recovery_code', { p_user_id: account.user.id, p_code: account.codes[3] })
    expect(verify.error).toBeNull()
    expect(verify.data).toBe(false)
  })

  await test.step('reloaded, Settings still shows two-factor off', async () => {
    await page.reload()
    await expect(twoFactor(page).getByText('Off', { exact: true })).toBeVisible({ timeout: 30000 })
  })
})

test('a connection lost after the first change reaches the server never strands a spent code', async ({ page }) => {
  test.setTimeout(180_000)
  const account = await enrolledUser('twofadrop')
  await signInWithTotp(page, account)
  await openTwoFactor(page)

  // The first request that changes two-factor state goes through; every later one is lost.
  const seen: string[] = []
  await page.route(() => true, async (route) => {
    const request = route.request()
    if (!changesTwoFactor(request)) return route.fallback()
    seen.push(`${request.method()} ${new URL(request.url()).pathname}`)
    return seen.length === 1 ? route.fallback() : route.abort('connectionreset')
  })

  await submitRecoveryCode(page, account.codes[0])
  const offToast = page.getByText('Two-factor authentication is off')
  const refused = disableDialog(page).getByRole('alert').filter({ hasText: /\S/ })
  await expect(offToast.or(refused)).toBeVisible({ timeout: 15000 })
  test.info().annotations.push({ type: 'two-factor requests', description: seen.join(', ') })

  const factors = await verifiedFactors(account.user)
  const status = await recoveryStatus(account.client)
  test.info().annotations.push({
    type: 'state after the drop',
    description: `verified factors ${factors.length}, codes ${status.remaining}/${status.total}`,
  })
  if (factors.length > 0) {
    expect(status).toMatchObject({ mfa_enabled: true, total: 10, remaining: 10 })
  } else {
    expect(status).toMatchObject({ mfa_enabled: false, total: 0, remaining: 0 })
  }

  expect(seen).toHaveLength(1)
  expect(factors).toEqual([])
  await expect(offToast).toBeVisible()
  await expect(twoFactor(page).getByText('Off', { exact: true })).toBeVisible()
})
