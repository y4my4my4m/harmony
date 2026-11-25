// Journey: a two-factor code answered after the 30 s sign-in bound. The dialog says the check
// timed out; GoTrue still accepts the code and stores the aal2 session, so the sign-in finishes
// and the app opens. Before 1.9.8 the dialog kept the timeout while the page held a half-adopted
// session, and the next load came up signed in.
//
// The page runs on a clock the test advances; GoTrue's answer to the verify is held until the
// bound has passed.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, loadApp, type SpecUser } from './harness'
import { enrolTotp, nextUnusedStep, totp, type TotpUser } from './totp'

const admin = adminClient()
let user: SpecUser
let account: TotpUser

test.beforeAll(async () => {
  user = await createUser(admin, 'latetotp')
  account = await enrolTotp(user)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const VERIFY_BOUND_MS = 30_000

test('a code verified after the timeout finishes the sign-in', async ({ page }) => {
  test.setTimeout(150_000)
  await page.clock.install()
  await loadApp(page, '/login', page.getByTestId('auth-email'))
  await page.getByTestId('auth-email').fill(user.email)
  await page.getByTestId('auth-password').fill(user.password)
  await page.getByTestId('auth-password').press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Two-factor authentication' })
  const code = dialog.getByRole('textbox', { name: 'Verification code' })
  await expect(code).toBeFocused({ timeout: 30000 })

  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let held = false
  await page.route('**/auth/v1/factors/*/verify', async (route) => {
    held = true
    await released
    await route.fallback()
  })

  await test.step('the code is sent and GoTrue does not answer within the bound', async () => {
    const step = await nextUnusedStep(page, account.usedStep)
    await page.keyboard.type(totp(account.secret, step))
    await expect.poll(() => held, { timeout: 15000 }).toBe(true)
    await page.clock.runFor(VERIFY_BOUND_MS + 1_000)
    await expect(page.getByTestId('twofa-error')).toContainText('timed out', { timeout: 10000 })
    await expect(page).toHaveURL(/\/login/)
  })

  await test.step('GoTrue accepts the code late: the sign-in finishes and the app opens', async () => {
    release()
    await page.waitForURL(/\/chat/, { timeout: 30000 })
    await expect(dialog).toBeHidden()
    await dismissAnnouncements(page)
  })

  await test.step('the sign-in is complete: a setting changed now is still there after a reload', async () => {
    // In-app navigation: a reload would sign in again through the session restore.
    await page.evaluate(() => {
      const root = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push(path: string): Promise<unknown> } } } } }
      return root.__vue_app__.config.globalProperties.$router.push('/settings/advanced')
    })
    const developerMode = page.getByRole('switch', { name: 'Developer mode' })
    await expect(developerMode).toHaveAttribute('aria-checked', 'false', { timeout: 30000 })
    await developerMode.click()
    await expect(developerMode).toHaveAttribute('aria-checked', 'true')

    await page.reload()
    await expect(page.getByRole('switch', { name: 'Developer mode' })).toHaveAttribute('aria-checked', 'true', { timeout: 30000 })
  })
})
