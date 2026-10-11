// Journey: signing up and in with the keyboard and a screen reader.
//
// Registration and sign-in driven by Tab, Space and Enter only: field errors are
// marked invalid, tied to their field and spoken (role=alert); the password
// toggle is a named toggle button; Remember me is a reachable checkbox; a
// rejected password is announced in the form; the forgot-password dialog takes
// focus and gives it back; the second-factor prompt is a labelled dialog whose
// one-time-code field takes focus. axe runs on each auth page and dialog.

import { createHmac } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  PASSWORD,
  userClient,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { animationsSettled, describedByText, focusWithin, tabTo } from './a11y-keyboard'

const signupEmails: string[] = []

const admin = adminClient()
let member: SpecUser
let mfaUser: SpecUser
let mfaSecret = ''
// Last 30 s step whose code was accepted; GoTrue may refuse a code reused within its step.
let mfaUsedStep = 0

// RFC 4648 base32 and RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as GoTrue issues.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch)
    if (v < 0) continue
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

function totp(secret: string, step = Math.floor(Date.now() / 30000)): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, '0')
}

test.beforeAll(async () => {
  member = await createUser(admin, 'a11yauth')
  mfaUser = await createUser(admin, 'a11ymfa')

  const client = await userClient(mfaUser)
  const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'e2e' })
  if (enrollError || !enrolled) throw new Error(`mfa enroll: ${enrollError?.message}`)
  mfaSecret = enrolled.totp.secret
  mfaUsedStep = Math.floor(Date.now() / 30000)
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: enrolled.id,
    code: totp(mfaSecret, mfaUsedStep),
  })
  if (verifyError) throw new Error(`mfa verify: ${verifyError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, mfaUser)
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  for (const created of data?.users?.filter((u) => u.email && signupEmails.includes(u.email)) ?? []) {
    await admin.from('profiles').delete().eq('id', created.id)
    await admin.auth.admin.deleteUser(created.id)
  }
})

async function openAuthPage(page: Page, path: '/login' | '/register') {
  await page.goto(path)
  await expect(page.getByTestId('auth-email')).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test('sign up with the keyboard: errors are tied and spoken, the password toggle is named', async ({ page }) => {
  test.setTimeout(180_000)
  const signupEmail = `a11ysignup${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.harmony.local`
  signupEmails.push(signupEmail)
  await openAuthPage(page, '/register')
  const email = page.getByRole('textbox', { name: 'Email' })
  const password = page.getByLabel('Password', { exact: true })

  await animationsSettled(page)

  await expectNoAxeViolations(page, { label: 'register page' })

  await test.step('submitting empty fields marks them invalid and focuses the first', async () => {
    await tabTo(page, email)
    await page.keyboard.press('Enter')
    await expect(email).toBeFocused()
    await expect(email).toHaveAttribute('aria-invalid', 'true')
    await expect(email).toHaveAccessibleDescription('Email is required')
    await expect(page.getByTestId('auth-email-error')).toHaveAttribute('role', 'alert')
    await expect(password).toHaveAttribute('aria-invalid', 'true')
    await expect(password).toHaveAccessibleDescription('Password is required')
  })

  await test.step('a malformed address is reported when leaving the field', async () => {
    await page.keyboard.type('not-an-address')
    await page.keyboard.press('Tab')
    await expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(await describedByText(email)).toBe('Please enter a valid email address')
    await tabTo(page, email, { backwards: true })
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(signupEmail)
    await expect(email).not.toHaveAttribute('aria-invalid', 'true')
  })

  await test.step('the password toggle is a focusable, named toggle button', async () => {
    await tabTo(page, password)
    await page.keyboard.type(PASSWORD)
    const toggle = page.getByRole('button', { name: 'Show password' })
    await page.keyboard.press('Tab')
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(password).toHaveAttribute('type', 'text')
    await page.keyboard.press('Space')
    await expect(password).toHaveAttribute('type', 'password')
  })

  await test.step('Enter on the submit button creates the account', async () => {
    await tabTo(page, page.getByRole('button', { name: 'Create account' }))
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/new-profile/, { timeout: 30000 })
  })
})

test('sign in with the keyboard: Remember me is reachable, a rejected password is announced', async ({ page }) => {
  test.setTimeout(180_000)
  await openAuthPage(page, '/login')
  const email = page.getByRole('textbox', { name: 'Email' })
  const password = page.getByLabel('Password', { exact: true })
  const remember = page.getByRole('checkbox', { name: 'Remember me' })

  await animationsSettled(page)

  await expectNoAxeViolations(page, { label: 'login page' })

  await test.step('Remember me is a checkbox in the tab sequence, toggled with Space', async () => {
    await tabTo(page, email)
    await page.keyboard.type(member.email)
    await page.keyboard.press('Tab')
    await expect(password).toBeFocused()
    await page.keyboard.type('not-the-password')
    await tabTo(page, remember, { max: 4 })
    await expect(remember).toBeChecked()
    await page.keyboard.press('Space')
    await expect(remember).not.toBeChecked()
    await page.keyboard.press('Space')
    await expect(remember).toBeChecked()
  })

  await test.step('a rejected password lands in the form alert', async () => {
    const answered = page.waitForResponse((r) => r.url().includes('/auth/v1/token'), { timeout: 30000 })
    await tabTo(page, password, { backwards: true })
    await page.keyboard.press('Enter')
    await answered
    const alert = page.getByTestId('auth-form-error')
    await expect(alert).toHaveAttribute('role', 'alert')
    await expect(alert).not.toHaveText('', { timeout: 15000 })
    await expect(page).toHaveURL(/login/)
  })

  await test.step('the right password signs in', async () => {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(member.password)
    await page.keyboard.press('Enter')
    await page.waitForURL(/\/chat/, { timeout: 30000 })
    await dismissAnnouncements(page)
  })
})

test('forgot password: a dialog that takes focus, ties its error and gives focus back', async ({ page }) => {
  test.setTimeout(120_000)
  await openAuthPage(page, '/login')
  const opener = page.getByRole('button', { name: 'Forgot your password?' })
  const dialog = page.getByRole('dialog', { name: 'Reset your password' })

  await tabTo(page, opener)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const field = dialog.getByRole('textbox', { name: 'Email' })
  await expect(field).toBeFocused()
  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'forgot-password dialog' })

  await test.step('Tab stays inside the dialog', async () => {
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect(await focusWithin(page, '[data-testid="forgot-password-dialog"]')).toBe(true)
    }
  })

  await test.step('a malformed address is tied to the field', async () => {
    await field.focus()
    await page.keyboard.type('nobody')
    await page.keyboard.press('Enter')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription('Please enter a valid email address')
  })

  await test.step('Escape closes the dialog and returns focus to its opener', async () => {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(page.getByTestId('auth-form')).toBeVisible()
  })
})

test('two-factor sign-in: a labelled dialog focuses a labelled one-time-code field', async ({ page }) => {
  test.setTimeout(180_000)
  await openAuthPage(page, '/login')
  await page.getByTestId('auth-email').fill(mfaUser.email)
  await page.getByTestId('auth-password').fill(mfaUser.password)
  await page.getByTestId('auth-password').press('Enter')

  const dialog = page.getByRole('dialog', { name: 'Two-factor authentication' })
  await expect(dialog).toBeVisible({ timeout: 30000 })
  await expect(dialog).toHaveAccessibleDescription(/6-digit verification code/)
  const code = dialog.getByRole('textbox', { name: 'Verification code' })
  await expect(code).toBeFocused()
  await expect(code).toHaveAttribute('inputmode', 'numeric')
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(dialog.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'two-factor dialog' })

  await test.step('Escape does not end the pending sign-in', async () => {
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(code).toBeFocused()
  })

  await test.step('a wrong code is spoken, tied to the field and keeps focus there', async () => {
    const wrong = totp(mfaSecret) === '000000' ? '111111' : '000000'
    await page.keyboard.type(wrong)
    const error = page.getByTestId('twofa-error')
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(error).not.toHaveText('', { timeout: 15000 })
    await expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(await describedByText(code)).toBe((await error.textContent())?.trim())
    await expect(code).toBeFocused()
  })

  await test.step('the right code signs in', async () => {
    while (Math.floor(Date.now() / 30000) <= mfaUsedStep) await page.waitForTimeout(1000)
    const step = Math.floor(Date.now() / 30000)
    await page.keyboard.type(totp(mfaSecret, step))
    await page.waitForURL(/\/chat/, { timeout: 30000 })
    mfaUsedStep = step
  })
})

test('password reset page: labelled fields, named toggles, tied errors', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: member.email,
    options: { redirectTo: `${baseURL}/reset-password` },
  })
  if (error || !data?.properties?.action_link) throw new Error(`recovery link: ${error?.message}`)
  // The stack's GoTrue reports its external URL without the gateway's /auth/v1 prefix.
  const link = new URL(data.properties.action_link)
  link.pathname = '/auth/v1/verify'
  await page.goto(link.toString())
  await expect(page.getByRole('heading', { level: 2, name: 'Reset your password' })).toBeVisible({ timeout: 30000 })

  const fresh = page.getByLabel('New password', { exact: true })
  const confirm = page.getByLabel('Confirm new password', { exact: true })
  await expect(fresh).toHaveAttribute('autocomplete', 'new-password')
  await animationsSettled(page)
  await expectNoAxeViolations(page, { label: 'reset-password page' })

  await test.step('each reveal toggle is named for its field and pressed when shown', async () => {
    const showNew = page.getByRole('button', { name: 'Show new password' })
    const showConfirm = page.getByRole('button', { name: 'Show password confirmation' })
    await tabTo(page, showNew)
    await page.keyboard.press('Space')
    await expect(showNew).toHaveAttribute('aria-pressed', 'true')
    await expect(fresh).toHaveAttribute('type', 'text')
    await expect(showConfirm).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('a mismatch is tied to the confirmation and focuses it', async () => {
    await fresh.focus()
    await page.keyboard.type('new-password-12345')
    await confirm.focus()
    await page.keyboard.type('different-password')
    await page.keyboard.press('Enter')
    await expect(confirm).toBeFocused()
    await expect(confirm).toHaveAttribute('aria-invalid', 'true')
    await expect(confirm).toHaveAccessibleDescription("Passwords don't match")
  })
})

